import type { LangfuseObservation } from "../../../emain/agent/observability/types";
import { expectTypeOf } from "vitest";

expectTypeOf<AgentObservabilityObservation>().toEqualTypeOf<LangfuseObservation>();
