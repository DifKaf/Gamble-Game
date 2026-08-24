import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'
import { questProgress, questByCode, dayRange } from '../utils/quests.js'
import { invalidate } from '../utils/cache.js'

export async function questRoutes(app: FastifyInstance) {
	// Список ежедневных квестов с текущим прогрессом.
	app.get('/', { preHandler: [(app as any).authenticate] }, async (request) => {
		const user = await getAuthUser(request)
		return questProgress(user.id)
	})

	// Забрать награду за выполненный квест.
	app.post('/claim', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		const parsed = z.object({ code: z.string().min(1) }).safeParse(request.body)
		if (!parsed.success) return reply.code(400).send({ error: 'Укажите квест' })

		const quest = questByCode(parsed.data.code)
		if (!quest) return reply.code(404).send({ error: 'Квест не найден' })

		const { periodKey } = dayRange()
		const progress = await questProgress(user.id)
		const item = progress.quests.find((q) => q.code === quest.code)
		if (!item || !item.done) return reply.code(400).send({ error: 'Квест ещё не выполнен' })
		if (item.claimed) return reply.code(400).send({ error: 'Награда уже получена' })

		try {
			const updated = await prisma.$transaction(async (tx) => {
				// Уникальный индекс (userId, questCode, periodKey) делает двойное нажатие безопасным.
				await tx.questClaim.create({
					data: { userId: user.id, questCode: quest.code, periodKey, reward: BigInt(quest.reward) }
				})
				return applyBalanceChange({
					tx,
					userId: user.id,
					amount: BigInt(quest.reward),
					type: 'BONUS',
					source: 'quest',
					metadata: { questCode: quest.code, periodKey, title: quest.title }
				})
			})

			invalidate(`quests:${user.id}`)
			const fresh = await questProgress(user.id)
			return { ok: true, reward: quest.reward, balance: Number(updated.balance), ...fresh }
		} catch (e: any) {
			if (String(e?.code) === 'P2002') return reply.code(400).send({ error: 'Награда уже получена' })
			throw e
		}
	})
}
