export async function applyBalanceChange(p) { const user = await p.tx.user.findUnique({ where: { id: p.userId } }); if (!user)
    throw new Error('User not found'); const before = user.balance; const after = before + p.amount; if (after < 0n)
    throw new Error('Insufficient balance'); const updated = await p.tx.user.update({ where: { id: p.userId }, data: { balance: after } }); await p.tx.walletTransaction.create({ data: { userId: p.userId, type: p.type, amount: p.amount, balanceBefore: before, balanceAfter: after, source: p.source, metadata: p.metadata } }); return updated; }
