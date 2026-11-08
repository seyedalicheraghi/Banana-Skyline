// The VR menu panel: shown over the demo (title) and when B/Y is pressed during a match.

import { CanvasPanel, COLORS, drawButton, drawCard, drawText } from './panels.js';

/** Button ids the menu can emit. */
export const MENU_ACTIONS = [
  'cpu-easy', 'cpu-normal', 'cpu-hard', 'two-players', 'throw-bow', 'throw-hand', 'throw-stick',
  'boost-low', 'boost-normal', 'boost-high', 'resume', 'quit', 'exit',
];

export class MenuPanel extends CanvasPanel {
  constructor() {
    super({ width: 1024, height: 1056, meters: 1.15, depthTest: true, renderOrder: 920, name: 'xr-menu' });
  }

  /**
   * @param {object} s
   * @param {'bow'|'hand'|'stick'} s.mode current throw mode
   * @param {boolean} s.inMatch a real match is running (offer Resume / Quit to title)
   * @param {'low'|'normal'|'high'} s.boost hand-throw boost
   * @param {?string} hover hovered button id
   */
  draw(s, hover = null) {
    this.redraw(JSON.stringify([s.mode, s.inMatch, s.boost, hover]), (ctx) => {
      const W = this.width;
      const m = 48;
      const full = W - m * 2;
      drawCard(ctx, W, this.height, { radius: 48 });
      drawText(ctx, 'BANANA SKYLINE', W / 2, 80, { px: 96, color: COLORS.accent, maxWidth: full });

      drawText(ctx, 'Play vs CPU', W / 2, 162, { px: 40, color: COLORS.dim });
      const gap = 24;
      const bw = (full - gap * 2) / 3;
      [['cpu-easy', 'Easy'], ['cpu-normal', 'Normal'], ['cpu-hard', 'Hard']].forEach(([id, label], i) => {
        const r = this.addButton(id, m + i * (bw + gap), 190, bw, 110);
        drawButton(ctx, { ...r, label, hover: hover === id, px: 50 });
      });

      const two = this.addButton('two-players', m, 324, full, 112);
      drawButton(ctx, { ...two, label: '2 Players', sub: 'pass the headset', hover: hover === 'two-players', px: 50 });

      drawText(ctx, 'Throw', W / 2, 456, { px: 32, color: COLORS.dim });
      const throws = [
        ['throw-bow', 'Bow', 'pull back, let go', s.mode === 'bow'],
        ['throw-hand', 'Hand', 'swing and let go', s.mode === 'hand'],
        ['throw-stick', 'Stick', 'thumbstick + trigger', s.mode === 'stick'],
      ];
      throws.forEach(([id, label, sub, selected], i) => {
        const r = this.addButton(id, m + i * (bw + gap), 474, bw, 104);
        drawButton(ctx, { ...r, label, sub, hover: hover === id, selected, px: 44 });
      });

      const hw = (full - gap) / 2;
      drawText(ctx, 'Hand throw boost (bananas fall short? pick High)', W / 2, 606, { px: 32, color: COLORS.dim, maxWidth: full });
      [['boost-low', 'Low'], ['boost-normal', 'Normal'], ['boost-high', 'High']].forEach(([id, label], i) => {
        const r = this.addButton(id, m + i * (bw + gap), 628, bw, 84);
        drawButton(ctx, { ...r, label, hover: hover === id, selected: (s.boost ?? 'normal') === id.slice('boost-'.length), px: 42 });
      });

      if (s.inMatch) {
        const resume = this.addButton('resume', m, 736, hw, 100);
        drawButton(ctx, { ...resume, label: 'Resume', hover: hover === 'resume' });
        const quit = this.addButton('quit', m + hw + gap, 736, hw, 100);
        drawButton(ctx, { ...quit, label: 'Quit to title', hover: hover === 'quit' });
      } else {
        drawText(ctx, 'Hit the other monkey with a banana.', W / 2, 760, { px: 38, weight: 500, maxWidth: full });
        drawText(ctx, 'Wind and gravity bend every throw.', W / 2, 810, { px: 38, weight: 500, maxWidth: full });
      }

      const exit = this.addButton('exit', W / 2 - 220, 860, 440, 100);
      drawButton(ctx, { ...exit, label: 'Exit VR', hover: hover === 'exit' });

      drawText(ctx, 'Point and pull the trigger  ·  B / Y toggles this menu', W / 2, 1006, {
        px: 30, weight: 500, color: COLORS.dim, maxWidth: full, shadow: false,
      });
    });
  }
}
