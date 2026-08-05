function evalRouletteBet(bet, number, color) {
    const amount = Number(bet.amount) || 0;
    const payload = bet.payload || bet;
    const selectedColor = payload.color;
    const selectedNumber = Number.isInteger(payload.number) ? payload.number : undefined;
    const outside = payload.outside;
    let win = false;
    let multiplier = 2;
    let selected = selectedColor;
    let selectedType = 'color';
    if (selectedNumber !== undefined && selectedNumber >= 0 && selectedNumber <= 36) {
        selectedType = 'number'; selected = selectedNumber; multiplier = 36; win = selectedNumber === number;
    }
    else if (outside) {
        selectedType = 'outside'; selected = outside;
        if (outside === 'first12') { win = number >= 1 && number <= 12; multiplier = 3; }
        else if (outside === 'second12') { win = number >= 13 && number <= 24; multiplier = 3; }
        else if (outside === 'third12') { win = number >= 25 && number <= 36; multiplier = 3; }
        else if (outside === 'low') { win = number >= 1 && number <= 18; }
        else if (outside === 'high') { win = number >= 19 && number <= 36; }
        else if (outside === 'even') { win = number !== 0 && number % 2 === 0; }
        else if (outside === 'odd') { win = number % 2 === 1; }
        else if (outside === 'row1') { win = [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36].includes(number); multiplier = 3; }
        else if (outside === 'row2') { win = [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35].includes(number); multiplier = 3; }
        else if (outside === 'row3') { win = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34].includes(number); multiplier = 3; }
    }
    else {
        selectedType = 'color'; selected = selectedColor || 'red'; multiplier = color === 'green' ? 14 : 2; win = selected === color;
    }
    const winAmount = win ? amount * multiplier : 0;
    return { amount, selected, selectedType, win, multiplier, winAmount };
}
export function playRoulette(p) {
    const number = Math.floor(Math.random() * 37);
    const color = number === 0 ? 'green' : number % 2 === 0 ? 'black' : 'red';
    const bets = Array.isArray(p.payload?.bets) && p.payload.bets.length ? p.payload.bets : [{ amount: p.betAmount, payload: p.payload || { color: 'red' } }];
    const results = bets.map(b => evalRouletteBet(b, number, color));
    const winAmount = Math.floor(results.reduce((s, b) => s + b.winAmount, 0));
    const first = results[0] || { selected: null, selectedType: 'color', multiplier: 0, win: false };
    return { game: 'roulette', selected: first.selected, selectedType: first.selectedType, number, color, win: winAmount > 0, multiplier: first.multiplier, winAmount, bets: results };
}
