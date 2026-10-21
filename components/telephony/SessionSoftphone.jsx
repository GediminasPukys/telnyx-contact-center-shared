"use client";
import FloatingSoftphone from "@/components/floating-softphone";
import { usePhoneChoice } from "./use-phone-choice";
export default function SessionSoftphone() {
  return ["webrtc","deskphone","sip"].includes(usePhoneChoice()?.kind) ? <FloatingSoftphone/> : null;
}
