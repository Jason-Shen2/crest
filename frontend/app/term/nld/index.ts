// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Public API for the NLD module.  Consumers (cmdblock-input, terminal-view)
// should import from this file rather than reaching into individual
// implementation files.

export type { ClassifierContext, InputClassification, NldClassifier, Tier1Classifier, Tier2Classifier } from "./types";

export { EMPTY_CONTEXT, NEUTRAL_CLASSIFICATION, classificationToMode } from "./types";

export { Classifier } from "./classifier";
export { HeuristicTier1 } from "./heuristic-tier1";
export { NLDModel } from "./nld-model";
export type { DetectionStatus } from "./nld-model";

export {
    StubClassifier,
    StubEmbedder,
    embedderReadyAtom,
    getClassifier,
    // Back-compat aliases — to be removed once external imports are updated.
    getEmbedder,
    setClassifier,
    setEmbedder,
} from "./embedder";
export { EdgeFlowEmbedder, EdgeFlowNldClassifier, ensureEmbedderWarm } from "./embedder-edgeflow";
