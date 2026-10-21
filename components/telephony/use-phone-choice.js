"use client";

import { useSyncExternalStore } from "react";
import { subscribeVoiceEndpoints, voiceLoginChoice } from "@/lib/telephony/endpoint-client";

const serverChoice = () => null;
export function usePhoneChoice() {
  return useSyncExternalStore(subscribeVoiceEndpoints, voiceLoginChoice, serverChoice);
}
