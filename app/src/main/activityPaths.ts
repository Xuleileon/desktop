import path from 'node:path';

export const ACTIVITY_DIR_NAME = 'activity';
export const ACTIVITY_EVENTS_FILE = 'activity-events.jsonl';

export function activityEventsPath(userDataPath: string): string {
  return path.join(userDataPath, ACTIVITY_DIR_NAME, ACTIVITY_EVENTS_FILE);
}
