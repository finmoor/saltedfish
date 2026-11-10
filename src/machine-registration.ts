import { ClientSetup, type SetupClient } from './client-setup.js';
import { BrowserError } from './shared.js';

export const machineRegistrationHelp = 'register-machine --client codex|opencode|claude --config ABS_FILE [--preview]';
export async function registerMachineCommand(backupDirectory: string, args: string[]) {
  const values = new Map<string, string>(); let preview = false;
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (name === '--preview' && !preview) { preview = true; continue; }
    if (['--client', '--config'].includes(name) && !values.has(name) && args[index + 1] && !args[index + 1]!.startsWith('--')) { values.set(name, args[++index]!); continue; }
    throw new BrowserError('INVALID_MACHINE_REGISTRATION', machineRegistrationHelp);
  }
  const client = values.get('--client'), file = values.get('--config');
  if (!client || !['codex', 'opencode', 'claude'].includes(client) || !file) throw new BrowserError('INVALID_MACHINE_REGISTRATION', machineRegistrationHelp);
  const setup = new ClientSetup({ dataDir: backupDirectory });
  const plan = await setup.previewMachineRegistration(client as SetupClient, file);
  return preview ? { preview: true, ...plan } : { ...await setup.apply(plan.planId), report: plan.report };
}
