import { randomUUID } from 'node:crypto';
import type { Executor } from './chapter-data.js';

export const AUTOMATION_AGENT_NAME = 'AI 写作引擎';

export interface AutomationAgent {
  id: string;
  email: string;
  name: string;
}

export function automationAgentEmail(workspaceId: string): string {
  return `ai+${workspaceId}@service.yunshuo.local`;
}

export async function ensureAutomationAgent(
  exec: Executor,
  workspaceId: string,
): Promise<AutomationAgent> {
  const email = automationAgentEmail(workspaceId);
  const rows = await exec<AutomationAgent[]>`
    INSERT INTO users (id, email, name, kind)
    VALUES (${randomUUID()}, ${email}, ${AUTOMATION_AGENT_NAME}, 'ai')
    ON CONFLICT (email) DO UPDATE SET kind = 'ai'
    RETURNING id, email, name
  `;
  const agent = rows[0];
  if (!agent) throw new Error('AI 服务主体创建失败');
  return agent;
}
