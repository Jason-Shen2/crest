import { expectTypeOf } from "vitest";
import type {
    Observation as StoredObservation,
    Score as StoredScore,
    Trace as StoredTrace,
    TraceDetail as StoredTraceDetail,
} from "../../../emain/agent/observability/types";

type SubscribeEvent = Parameters<Window["api"]["agentObservability"]["subscribe"]>[1] extends (
    event: infer Event
) => void
    ? Event
    : never;

expectTypeOf<Trace>().toEqualTypeOf<StoredTrace>();
expectTypeOf<Observation>().toEqualTypeOf<StoredObservation>();
expectTypeOf<Score>().toEqualTypeOf<StoredScore>();
expectTypeOf<TraceDetail>().toEqualTypeOf<StoredTraceDetail>();
expectTypeOf<Window["api"]["agentObservability"]["listTraces"]>().returns.resolves.toEqualTypeOf<Trace[]>();
expectTypeOf<Window["api"]["agentObservability"]["getTrace"]>().returns.resolves.toEqualTypeOf<
    TraceDetail | undefined
>();
expectTypeOf<SubscribeEvent>().toHaveProperty("detail").toEqualTypeOf<TraceDetail>();
