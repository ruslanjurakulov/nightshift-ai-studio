"use client";

import { createContext } from "react";
import { NO_LOCKS, type SyncLocks } from "@/lib/editorSync";

/** The timeline's sync locks (lib/editorSync.ts), for the inspector's ripple edits that run deep in it (silence cuts). */
export const SyncLocksContext = createContext<SyncLocks>(NO_LOCKS);
