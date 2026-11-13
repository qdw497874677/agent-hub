import { DialogShell } from '../shell/dialog-shell.tsx';
import { DisplaySettingsPanel } from './chat-blocks.tsx';
import type { DisplaySettings } from './display-settings.ts';

/** 手机上没有地方放「Aa」，从「更多」打开同一组显示设置。 */
export function DisplaySettingsDialog({
  settings,
  onChange,
  onClose
}: {
  settings: DisplaySettings;
  onChange: (patch: Partial<DisplaySettings>) => void;
  onClose: () => void;
}) {
  return (
    <DialogShell title="显示设置" onClose={onClose}>
      <div className="mb-2 flex items-center gap-2">
        <p className="text-head text-primary">显示设置</p>
        <button className="ml-auto h-9 px-2 text-meta text-tertiary hover:text-primary" onClick={onClose}>
          关闭
        </button>
      </div>
      <DisplaySettingsPanel settings={settings} onChange={onChange} />
    </DialogShell>
  );
}
