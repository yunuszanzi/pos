import { create } from "zustand";

type TerminalState = {
  terminalId: string;
  setTerminalId: (terminalId: string) => void;
};

export const useTerminalStore = create<TerminalState>((set) => ({
  terminalId: localStorage.getItem("pos.terminalId") ?? "",
  setTerminalId: (terminalId) => {
    localStorage.setItem("pos.terminalId", terminalId);
    set({ terminalId });
  },
}));
