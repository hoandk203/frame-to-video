import { create } from 'zustand';
import type { Project, ExportJob } from '../../../packages/contracts/src/index.js';
interface StudioState {
  project: Project | null;
  job: ExportJob | null;
  currentFrame: number;
  busy: boolean;
  error: string | null;
  set: (patch: Partial<Omit<StudioState, 'set'>>) => void;
}
export const useStudio = create<StudioState>((set) => ({
  project: null,
  job: null,
  currentFrame: 0,
  busy: false,
  error: null,
  set,
}));
