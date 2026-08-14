export function playDice(p) {
    const mode = p.payload?.mode || 'over';
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const roll = d1 + d2;
    const win = mode === 'exact' ? roll === 7 : (mode === 'under' ? roll < 7 : roll > 7);
    const multiplier = mode === 'exact' ? 5 : 1.9;
    const winAmount = win ? Math.floor(p.betAmount * multiplier) : 0;
    return { game: 'dice', dice: [d1, d2], d1, d2, roll, mode, target: mode === 'exact' ? 7 : 7, win, multiplier, winAmount };
}
