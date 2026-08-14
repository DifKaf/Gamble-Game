export function playBaccarat(p) {
    const side = p.payload?.side || 'player';
    function card() { return Math.floor(Math.random() * 13) + 1; }
    function val(c) { return c >= 10 ? 0 : c; }
    const player = [card(), card()];
    const banker = [card(), card()];
    const playerTotal = (val(player[0]) + val(player[1])) % 10;
    const bankerTotal = (val(banker[0]) + val(banker[1])) % 10;
    const winner = playerTotal === bankerTotal ? 'tie' : (playerTotal > bankerTotal ? 'player' : 'banker');
    const multiplier = winner === 'tie' ? 8 : (winner === 'banker' ? 1.95 : 2);
    const win = side === winner;
    const winAmount = win ? Math.floor(p.betAmount * multiplier) : 0;
    return { game: 'baccarat', selected: side, winner, player, banker, playerTotal, bankerTotal, win, multiplier, winAmount };
}
