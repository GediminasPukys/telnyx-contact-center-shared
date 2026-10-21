"use client";
import useActiveCallStore from "@/lib/stores/active-call-store";
import { submitCoreHoldIntent } from "@/lib/acd/client-hold-intent";
import { createCallStateActions } from "./call-controller.mjs";
export const callStateActions = createCallStateActions({ getState: useActiveCallStore.getState, submitHold: submitCoreHoldIntent });
