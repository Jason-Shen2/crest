// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import "@xterm/xterm/css/xterm.css";
import "overlayscrollbars/overlayscrollbars.css";
import "./app/app.scss";

// Tailwind must follow app.scss so its utilities override legacy component styles.
import "./tailwindsetup.css";
