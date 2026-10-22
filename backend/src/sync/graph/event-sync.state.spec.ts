import { StateGraph, START, END } from '@langchain/langgraph';
import { EventSyncStateAnnotation, type EventSyncUpdate } from './event-sync.state';

/**
 * The counters reducer is the one piece of graph wiring with real logic in it:
 * nodes report deltas and the graph sums them. Getting this wrong makes every
 * number the sync reports — and the smoke test asserts — silently wrong.
 *
 * Exercised through a compiled graph rather than by reaching into the
 * annotation's internals, so this keeps testing our behaviour and not
 * LangGraph's private shape.
 */
describe('EventSyncStateAnnotation', () => {
  function graphOf(...updates: EventSyncUpdate[]) {
    let builder = new StateGraph(EventSyncStateAnnotation) as any;
    updates.forEach((update, i) => {
      builder = builder.addNode(`n${i}`, async () => update);
    });
    builder = builder.addEdge(START, 'n0');
    for (let i = 1; i < updates.length; i++) {
      builder = builder.addEdge(`n${i - 1}`, `n${i}`);
    }
    return builder.addEdge(`n${updates.length - 1}`, END).compile();
  }

  it('starts every counter at zero', async () => {
    // A node must write *some* channel: LangGraph resolves to undefined when
    // nothing was written at all.
    const result = await graphOf({ groups: [] }).invoke({});

    expect(result.counters).toEqual({
      messagesParsed: 0,
      messagesFailed: 0,
      eventsCreated: 0,
      eventsSynced: 0,
    });
  });

  it('adds deltas across nodes instead of replacing totals', async () => {
    const result = await graphOf(
      { counters: { messagesParsed: 2 } }, // dedupFilter
      { counters: { messagesParsed: 3, eventsCreated: 1 } }, // processGroups
      { counters: { eventsSynced: 1 } }, // syncToGoogle
    ).invoke({});

    expect(result.counters).toEqual({
      messagesParsed: 5,
      messagesFailed: 0,
      eventsCreated: 1,
      eventsSynced: 1,
    });
  });

  it('treats an omitted counter as zero rather than undefined', async () => {
    const result = await graphOf({ counters: { eventsSynced: 2 } }).invoke({});

    expect(result.counters.messagesParsed).toBe(0);
    expect(result.counters.eventsSynced).toBe(2);
  });

  it('replaces rather than merges the non-counter fields', async () => {
    const result = await graphOf(
      { freshIndices: [0, 1, 2] },
      { freshIndices: [5] },
    ).invoke({});

    expect(result.freshIndices).toEqual([5]);
  });

  it('defaults collections to empty so a node can read them unguarded', async () => {
    const result = await graphOf({ quotaExhausted: false }).invoke({});

    expect(result.groups).toEqual([]);
    expect(result.freshIndices).toEqual([]);
    expect(result.duplicateIndices).toEqual([]);
    expect(result.savedEvents).toEqual([]);
    expect(result.parsed).toEqual(new Map());
    expect(result.quotaExhausted).toBe(false);
    expect(result.approvalEnabled).toBe(false);
  });
});
