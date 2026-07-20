// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

import { expectTypeOf } from "vitest";

import type { IOPreviewProps } from "./io-preview";

type CopyScopeKey = Pick<IOPreviewProps, "copyScopeKey">;
type CopyScopeKeyIsRequired = CopyScopeKey extends Required<CopyScopeKey> ? true : false;

expectTypeOf<CopyScopeKeyIsRequired>().toEqualTypeOf<true>();
