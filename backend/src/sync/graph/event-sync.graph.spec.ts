import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { EventSyncGraph } from './event-sync.graph';
import { TracingService } from '../../llm/observability/tracing.service';
import { LoadMessagesNode } from './nodes/load-messages.node';
import { DedupFilterNode } from './nodes/dedup-filter.node';
import { ExtractNode } from './nodes/extract.node';
import { PersistEventsNode } from './nodes/persist-events.node';
import { ScreenEventsNode } from './nodes/screen-events.node';
import { RequestApprovalNode } from './nodes/request-approval.node';
import { ProcessDismissalsNode } from './nodes/process-dismissals.node';
import { SyncToGoogleNode } from './nodes/sync-to-google.node';
import type { EventSyncUpdate } from './event-sync.state';

/**
 * Routing and node-contract tests.
 *
 * Every node is replaced by a recorder, so what is under test is the wiring
 * itself — which edges fire, in what order, and what each node is allowed to
 * do — rather than any node's behaviour. Node behaviour is covered by the
 * per-node specs and by `event-sync.service.spec.ts`.
 */
describe('EventSyncGraph', () => {
  let graph: EventSyncGraph;
  let visited: string[];
  let nodeReturns: Record<string, EventSyncUpdate>;
  let createQueryRunner: jest.Mock;

  const recorder = (name: string) => ({
    run: jest.fn(async () => {
      visited.push(name);
      return nodeReturns[name] ?? {};
    }),
  });

  let nodes: Record<string, { run: jest.Mock }>;

  beforeEach(async () => {
    visited = [];
    nodeReturns = {};
    createQueryRunner = jest.fn();

    nodes = {
      loadMessages: recorder('loadMessages'),
      dedupFilter: recorder('dedupFilter'),
      extract: recorder('extract'),
      persistEvents: recorder('persistEvents'),
      screenEvents: recorder('screenEvents'),
      requestApproval: recorder('requestApproval'),
      processDismissals: recorder('processDismissals'),
      syncToGoogle: recorder('syncToGoogle'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventSyncGraph,
        { provide: LoadMessagesNode, useValue: nodes.loadMessages },
        { provide: DedupFilterNode, useValue: nodes.dedupFilter },
        { provide: ExtractNode, useValue: nodes.extract },
        { provide: PersistEventsNode, useValue: nodes.persistEvents },
        { provide: ScreenEventsNode, useValue: nodes.screenEvents },
        { provide: RequestApprovalNode, useValue: nodes.requestApproval },
        { provide: ProcessDismissalsNode, useValue: nodes.processDismissals },
        { provide: SyncToGoogleNode, useValue: nodes.syncToGoogle },
        { provide: DataSource, useValue: { createQueryRunner } },
        {
          provide: TracingService,
          // Tracing off: no callbacks, no LangSmith client, no network.
          useValue: { callbacks: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    graph = module.get(EventSyncGraph);
  });

  const fresh = { freshIndices: [0], groups: [{} as any] };

  describe('routing', () => {
    it('runs the full path when there is fresh work and approval is on', async () => {
      nodeReturns.dedupFilter = fresh;
      nodeReturns.persistEvents = {
        savedEvents: [{ id: 'e1' } as any],
      };
      nodeReturns.extract = { approvalEnabled: true };

      await graph.run();

      expect(visited).toEqual([
        'loadMessages',
        'dedupFilter',
        'extract',
        'persistEvents',
        'screenEvents',
        'requestApproval',
        'processDismissals',
        'syncToGoogle',
      ]);
    });

    it('skips extraction entirely when every group was a duplicate', async () => {
      nodeReturns.dedupFilter = { freshIndices: [] };
      await graph.run();
      expect(visited).toEqual(['loadMessages', 'dedupFilter', 'syncToGoogle']);
      expect(nodes.extract.run).not.toHaveBeenCalled();
    });

    it('skips persistence when the account ran out of credit mid-pass', async () => {
      nodeReturns.dedupFilter = fresh;
      nodeReturns.extract = { quotaExhausted: true };
      await graph.run();
      expect(visited).toEqual([
        'loadMessages',
        'dedupFilter',
        'extract',
        'syncToGoogle',
      ]);
      expect(nodes.persistEvents.run).not.toHaveBeenCalled();
    });

    it('skips screening and approval when approval is switched off', async () => {
      nodeReturns.dedupFilter = fresh;
      nodeReturns.extract = { approvalEnabled: false };
      nodeReturns.persistEvents = { savedEvents: [{ id: 'e1' } as any] };

      await graph.run();

      expect(nodes.screenEvents.run).not.toHaveBeenCalled();
      expect(nodes.requestApproval.run).not.toHaveBeenCalled();
      expect(visited).toContain('processDismissals');
    });

    it('skips screening when approval is on but nothing was saved', async () => {
      nodeReturns.dedupFilter = fresh;
      nodeReturns.extract = { approvalEnabled: true };
      nodeReturns.persistEvents = { savedEvents: [] };

      await graph.run();

      expect(nodes.screenEvents.run).not.toHaveBeenCalled();
      expect(visited).toContain('processDismissals');
    });

    /**
     * Events approved in an earlier pass, or left behind by a failed push, are
     * still waiting — so the Google push runs even on the short-circuit paths.
     */
    it('pushes to Google on every path, including both short-circuits', async () => {
      nodeReturns.dedupFilter = { freshIndices: [] };
      await graph.run();
      expect(visited).toContain('syncToGoogle');

      visited = [];
      nodeReturns.dedupFilter = fresh;
      nodeReturns.extract = { quotaExhausted: true };
      await graph.run();
      expect(visited).toContain('syncToGoogle');
    });

    it('applies dismissals after approval, so a cancel can reach a new event', async () => {
      nodeReturns.dedupFilter = fresh;
      nodeReturns.extract = { approvalEnabled: true };
      nodeReturns.persistEvents = { savedEvents: [{ id: 'e1' } as any] };

      await graph.run();

      expect(visited.indexOf('processDismissals')).toBeGreaterThan(
        visited.indexOf('requestApproval'),
      );
    });
  });

  describe('counters', () => {
    it('sums each node’s delta rather than letting the last write win', async () => {
      nodeReturns.dedupFilter = {
        ...fresh,
        counters: { messagesParsed: 2 },
      };
      nodeReturns.persistEvents = {
        counters: { messagesParsed: 3, messagesFailed: 1, eventsCreated: 4 },
      };
      nodeReturns.syncToGoogle = { counters: { eventsSynced: 5 } };

      await expect(graph.run()).resolves.toEqual({
        messagesParsed: 5,
        messagesFailed: 1,
        eventsCreated: 4,
        eventsSynced: 5,
        quotaExhausted: false,
      });
    });

    it('reports zeros when there is no work at all', async () => {
      nodeReturns.dedupFilter = { freshIndices: [] };
      await expect(graph.run()).resolves.toEqual({
        messagesParsed: 0,
        messagesFailed: 0,
        eventsCreated: 0,
        eventsSynced: 0,
        quotaExhausted: false,
      });
    });

    it('surfaces quota exhaustion to the caller', async () => {
      nodeReturns.dedupFilter = fresh;
      nodeReturns.extract = { quotaExhausted: true };
      const result = await graph.run();
      expect(result.quotaExhausted).toBe(true);
    });
  });

  /**
   * The single most important invariant in the pipeline. A `QueryRunner` held
   * across an edge keeps a SQLite write transaction open while the runtime
   * awaits, which locks the database file for every other caller in the app.
   * Nodes are therefore the transaction boundary: whatever a node opens, it
   * closes before returning.
   */
  describe('node contract', () => {
    it('leaves no query runner open across an edge', async () => {
      const runners: { released: boolean }[] = [];
      createQueryRunner.mockImplementation(() => {
        const runner = {
          released: false,
          connect: jest.fn(),
          startTransaction: jest.fn(),
          commitTransaction: jest.fn(),
          rollbackTransaction: jest.fn(),
          release: jest.fn(function (this: any) {
            this.released = true;
          }),
          manager: { create: jest.fn(), save: jest.fn(), update: jest.fn() },
        };
        runners.push(runner);
        return runner;
      });

      // Each node that touches the database opens and releases its own runner.
      const transactional = (name: string) =>
        jest.fn(async () => {
          visited.push(name);
          const runner = createQueryRunner();
          await runner.connect();
          await runner.startTransaction();
          await runner.commitTransaction();
          await runner.release();
          // Nothing must still be open at the moment this node returns.
          expect(runners.every((r) => r.released)).toBe(true);
          return nodeReturns[name] ?? {};
        });

      nodes.dedupFilter.run = transactional('dedupFilter');
      nodes.persistEvents.run = transactional('persistEvents');
      nodeReturns.dedupFilter = fresh;

      await graph.run();

      expect(runners).toHaveLength(2);
      expect(runners.every((r) => r.released)).toBe(true);
    });

    it('rolls a node’s failure up rather than reporting a half-done pass', async () => {
      nodeReturns.dedupFilter = fresh;
      nodes.persistEvents.run.mockRejectedValue(new Error('db write failed'));

      await expect(graph.run()).rejects.toThrow('db write failed');
      // The push must not run on a pass that never persisted anything.
      expect(nodes.syncToGoogle.run).not.toHaveBeenCalled();
    });
  });
});
