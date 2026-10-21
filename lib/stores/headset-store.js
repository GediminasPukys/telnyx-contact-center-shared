"use client";
import { create } from "zustand";
const useHeadsetStore = create(set => ({
  enabled: false, status: "disabled", device: null, devices: [], selectedKey: null, sync: "idle", error: null, busy: false,
  diagnostics: [], audio: { inputId: "", outputId: "", error: null }, audioDevices: [], audioLoading: false, audioSuggestion: null,
  update: patch => set(patch),
  recordDiagnostic: entry => set(state => ({ diagnostics: [{ at: new Date().toISOString(), ...entry }, ...state.diagnostics].slice(0, 200) })),
}));
export default useHeadsetStore;
