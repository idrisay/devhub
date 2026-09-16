import { REVIEW_PROMPT_PLACEHOLDERS } from '../providers/github/reviewPrompt';
import { UPDATE_PROMPT_PLACEHOLDERS } from '../providers/github/updatePrompt';
import { PROMPT_PLACEHOLDERS } from '../providers/jira/promptTemplate';

/** Which copy button a prompt belongs to. */
export type PromptSettingId = 'tasks' | 'review' | 'update';

export interface PromptSetting {
  id: PromptSettingId;
  /** Full setting id, which is what the Settings UI is opened with. */
  setting: string;
  /** Key relative to the `devhub` section, which is how Config reads it. */
  key: string;
  /** The view whose rows carry the button. */
  view: string;
  placeholders: readonly string[];
}

export const PROMPT_SETTINGS: readonly PromptSetting[] = [
  {
    id: 'tasks',
    setting: 'devhub.tasks.promptTemplate',
    key: 'tasks.promptTemplate',
    view: 'My tasks',
    placeholders: PROMPT_PLACEHOLDERS
  },
  {
    id: 'review',
    setting: 'devhub.github.reviewPromptTemplate',
    key: 'github.reviewPromptTemplate',
    view: 'Awaiting my review',
    placeholders: REVIEW_PROMPT_PLACEHOLDERS
  },
  {
    id: 'update',
    setting: 'devhub.github.updatePromptTemplate',
    key: 'github.updatePromptTemplate',
    view: 'My open pull requests',
    placeholders: UPDATE_PROMPT_PLACEHOLDERS
  }
];

/**
 * Every prompt setting defaults to empty meaning "use the built-in text", so a
 * value only counts as an override once it holds something other than
 * whitespace — the same test Config applies when it decides which text to use.
 */
export function isCustomised(raw: string | undefined): boolean {
  return (raw ?? '').trim().length > 0;
}

export function describePromptSetting(raw: string | undefined): string {
  return isCustomised(raw) ? 'Customised' : 'Built-in default';
}

/** The placeholder list as it reads in a quick pick's detail line. */
export function placeholderHint(setting: PromptSetting): string {
  return setting.placeholders.map((name) => '${' + name + '}').join(' ');
}

export type SettingScope = 'workspaceFolder' | 'workspace' | 'global';

/**
 * Where to write an override.
 *
 * A value that already exists is edited where it lives, so seeding the setting
 * never quietly promotes a workspace override into a user-wide one. Anything
 * else goes to user settings, which is where a prompt normally belongs: it
 * follows the person rather than the repository.
 */
export function scopeFor(
  inspected: { workspaceFolderValue?: string; workspaceValue?: string } | undefined
): SettingScope {
  if (inspected?.workspaceFolderValue !== undefined) {
    return 'workspaceFolder';
  }
  if (inspected?.workspaceValue !== undefined) {
    return 'workspace';
  }
  return 'global';
}

export interface PromptAction {
  setting: PromptSetting;
  action: 'edit' | 'reset';
  label: string;
  description: string;
  detail: string;
}

/**
 * The quick pick for the edit command: one entry per prompt, then a reset for
 * each one that has been overridden. Resets come last as a group so they never
 * sit next to the entry a user is aiming for.
 */
export function promptActions(raw: Record<PromptSettingId, string | undefined>): PromptAction[] {
  const edits = PROMPT_SETTINGS.map((setting): PromptAction => ({
    setting,
    action: 'edit',
    label: `$(edit) ${setting.view}`,
    description: describePromptSetting(raw[setting.id]),
    detail: `Placeholders: ${placeholderHint(setting)}`
  }));
  const resets = PROMPT_SETTINGS.filter((setting) => isCustomised(raw[setting.id])).map(
    (setting): PromptAction => ({
      setting,
      action: 'reset',
      label: `$(discard) Reset ${setting.view} to the built-in prompt`,
      description: '',
      detail: setting.setting
    })
  );
  return [...edits, ...resets];
}
