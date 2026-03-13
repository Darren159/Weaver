import { BrowserWindow, Menu, Tray } from 'electron';
import { createWeaverIcon } from './icon';

export function createTray(win: BrowserWindow, onQuit: () => void): Tray {
  const tray = new Tray(createWeaverIcon());
  tray.setToolTip('Weaver');

  let alwaysOnTop = true;

  const buildMenu = () => Menu.buildFromTemplate([
    {
      label: 'Show / Hide',
      click: () => toggle(),
    },
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (item) => {
        alwaysOnTop = item.checked;
        win.setAlwaysOnTop(alwaysOnTop);
      },
    },
    { type: 'separator' },
    { label: 'Quit Weaver', click: onQuit },
  ]);

  tray.setContextMenu(buildMenu());

  // Left-click toggles on Windows/Linux
  tray.on('click', () => toggle());

  function toggle() {
    if (win.isVisible() && win.isFocused()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  }

  return tray;
}
