import { Injectable, Logger } from '@nestjs/common';
import { StateGraph, START, END } from '@langchain/langgraph';
import { TracingService } from '../../llm/observability/tracing.service';
import {
  EventSyncStateAnnotation,
  type EventSyncState,
  type SyncCounters,
} from './event-sync.state';
import { LoadMessagesNode } from './nodes/load-messages.node';
import { DedupFilterNode } from './nodes/dedup-filter.node';
import { ExtractNode } from './nodes/extract.node';
import { PersistEventsNode } from './nodes/persist-events.node';
import { ScreenEventsNode } from './nodes/screen-events.node';
import { RequestApprovalNode } from './nodes/request-approval.node';
import { ProcessDismissalsNode } from './nodes/process-dismissals.node';
import { SyncToGoogleNode } from './nodes/sync-to-google.node';

const ZERO: SyncCounters = {
  messagesParsed: 0,
  messagesFailed: 0,
  eventsCreated: 0,
  eventsSynced: 0,
};

/**
 * The event-sync pass, as a graph.
 *
 * ```
 * loadMessages → dedupFilter ─┬─(nothing fresh)──────────────────→ syncToGoogle
 *                             └→ extract ─┬─(quota exhausted)────→ syncToGoogle
 *                                         └→ persistEvents ─┬─(no approval)→ processDismissals
 *                                                           └→ screenEvents → requestApproval → processDismissals
 *                                                                                                    ↓
 *                                                                                              syncToGoogle → END
 * ```
 *
 * Each conditional edge exists because taking the long way round costs
 * something real: an extraction call for nothing, a doomed call against a
 * depleted account, or a screening pass over events nobody will be asked
 * about. `syncToGoogle` is on every path, including both short-circuits —
 * events from earlier passes may still be waiting to be pushed.
 *
 * **Compiled without a checkpointer, deliberately.** Checkpointing earns its
 * keep when a graph resumes mid-pass, and this one never does: unparsed
 * message rows are already the durable work queue, so a crash halfway through
 * is recovered by the next sync reading the same rows. A `MemorySaver` would
 * add a per-thread copy of the state for no recovery benefit — and, being
 * in-memory, would not survive the restart it would supposedly protect against.
 *
 * **Every node is a transaction boundary.** No `QueryRunner` is held across an
 * edge; one left open while the runtime awaits would lock the SQLite file for
 * every other caller in the app.
 */
@Injectable()
export class EventSyncGraph {
  private readonly logger = new Logger(EventSyncGraph.name);
  private compiled: ReturnType<EventSyncGraph['build']> | null = null;

  constructor(
    private readonly loadMessages: LoadMessagesNode,
    private readonly dedupFilter: DedupFilterNode,
    private readonly extract: ExtractNode,
    private readonly persistEvents: PersistEventsNode,
    private readonly screenEvents: ScreenEventsNode,
    private readonly requestApproval: RequestApprovalNode,
    private readonly processDismissals: ProcessDismissalsNode,
    private readonly syncToGoogle: SyncToGoogleNode,
    private readonly tracingService: TracingService,
  ) {}

  /** Run one pass and return its counters. */
  async run(): Promise<SyncCounters & { quotaExhausted: boolean }> {
    const graph = (this.compiled ??= this.build());
    const callbacks = await this.tracingService.callbacks();

    const final = await graph.invoke({}, { callbacks, runName: 'event-sync' });

    // LangGraph resolves a channel to undefined when no node wrote it. Every
    // path here writes counters, but crashing the daily sync over a defaulting
    // detail is not a risk worth taking.
    return {
      ...(final?.counters ?? ZERO),
      quotaExhausted: final?.quotaExhausted ?? false,
    };
  }

  private build() {
    return new StateGraph(EventSyncStateAnnotation)
      .addNode('loadMessages', () => this.loadMessages.run())
      .addNode('dedupFilter', (s: EventSyncState) => this.dedupFilter.run(s))
      .addNode('extract', (s: EventSyncState) => this.extract.run(s))
      .addNode('persistEvents', (s: EventSyncState) =>
        this.persistEvents.run(s),
      )
      .addNode('screenEvents', (s: EventSyncState) => this.screenEvents.run(s))
      .addNode('requestApproval', (s: EventSyncState) =>
        this.requestApproval.run(s),
      )
      .addNode('processDismissals', (s: EventSyncState) =>
        this.processDismissals.run(s),
      )
      .addNode('syncToGoogle', () => this.syncToGoogle.run())

      .addEdge(START, 'loadMessages')
      .addEdge('loadMessages', 'dedupFilter')

      // Nothing fresh: every group was a duplicate, so there is nothing to
      // extract and nothing to persist.
      .addConditionalEdges(
        'dedupFilter',
        (s: EventSyncState) =>
          s.freshIndices.length === 0 ? 'syncToGoogle' : 'extract',
        ['extract', 'syncToGoogle'],
      )

      // Depleted account: the groups stay unparsed for the next sync rather
      // than being persisted as "no events found".
      .addConditionalEdges(
        'extract',
        (s: EventSyncState) =>
          s.quotaExhausted ? 'syncToGoogle' : 'persistEvents',
        ['persistEvents', 'syncToGoogle'],
      )

      // Screening only earns its LLM and embedding calls when someone will
      // actually be asked to approve the result.
      .addConditionalEdges(
        'persistEvents',
        (s: EventSyncState) =>
          s.approvalEnabled && s.savedEvents.length > 0
            ? 'screenEvents'
            : 'processDismissals',
        ['screenEvents', 'processDismissals'],
      )

      .addEdge('screenEvents', 'requestApproval')
      .addEdge('requestApproval', 'processDismissals')
      .addEdge('processDismissals', 'syncToGoogle')
      .addEdge('syncToGoogle', END)
      .compile();
  }
}
