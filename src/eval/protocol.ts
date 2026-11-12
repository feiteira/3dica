// §5.3 — worker protocol (exact). Messages between the main thread (eval/client.ts) and the worker (eval/worker.ts).
import type { Id, Mat4, Vec3 } from '../core/types'
import type { Job } from '../core/evalspec'

export type ToWorker =
  | { type: 'eval'; id: number; job: Job }
  | { type: 'stl';  id: number; items: { job: Job; matrix: Mat4 }[] }

export type FromWorker =
  | { type: 'ready'; lineOffset: number; flatNames: number }
  | { type: 'result'; id: number; resultKey: string; ok: true;  meshes: MeshData[]; tris: number; ms: number; warnings: string[] }
  | { type: 'result'; id: number; resultKey: string; ok: false; error: EvalError; ms: number }
  | { type: 'stl';    id: number; ok: true;  parts: ArrayBuffer[]; tris: number }
  | { type: 'stl';    id: number; ok: false; error: EvalError }

export interface MeshData {
  positions: Float32Array; normals: Float32Array     // non-indexed triangles, 9 floats per tri
  color?: [number, number, number, number]          // baked by code via colorize (sRGB 0..1)
  bbox: [Vec3, Vec3]
}
export interface EvalError {
  kind: 'syntax' | 'runtime' | 'result' | 'cycle' | 'dependency' | 'timeout' | 'crash'
  def: Id; defName: string          // the def whose code actually failed (innermost)
  message: string; line?: number; col?: number
  trace: string[]                   // def names from the job root to the failing def
}
