// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

import { expectTypeOf } from "vitest";

import type { IOPreviewProps } from "./io-preview";

type CopyScopeKeyIsRequired = {} extends Pick<IOPreviewProps, "copyScopeKey"> ? false : true;

expectTypeOf<CopyScopeKeyIsRequired>().toEqualTypeOf<true>();
