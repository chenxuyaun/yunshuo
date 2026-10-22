import type { Role } from './types.js';

export const HUMAN_ROLES = ['owner', 'lead', 'author', 'reviewer', 'viewer', 'billing'] as const;

export type HumanRole = (typeof HUMAN_ROLES)[number];

export function isHumanRole(role: string): role is HumanRole {
  return (HUMAN_ROLES as readonly string[]).includes(role);
}

export function canViewMembers(role: Role): boolean {
  return role === 'owner' || role === 'lead';
}

export function canManageMembers(role: Role): boolean {
  return role === 'owner';
}

export function canInviteRole(actor: Role, target: HumanRole): boolean {
  if (actor === 'owner') return true;
  if (actor === 'lead') return target !== 'owner' && target !== 'lead';
  return false;
}
