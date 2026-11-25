import { PROFESSIONS, type Profession, type ProfessionId } from './types';

const byId = new Map<string, Profession>(PROFESSIONS.map((p) => [p.id, p]));

export function profession(id: string): Profession | undefined {
  return byId.get(id);
}

export function isProfessionId(id: unknown): id is ProfessionId {
  return typeof id === 'string' && byId.has(id);
}

export function professionName(id: ProfessionId): string {
  return byId.get(id)!.name;
}
