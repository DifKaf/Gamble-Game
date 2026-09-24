import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { attachReferral, referralStats, payReferralMilestones, resolveBotInfo } from '../utils/referrals.js'

const REASONS: Record<string, string> = {
	invalid_code: 'Некорректный код приглашения',
	already_attached: 'Приглашение уже учтено',
	window_closed: 'Код работает только в первые дни после регистрации',
	referrer_not_found: 'Игрок с таким ID не найден',
	self_invite: 'Нельзя пригласить самого себя',
	user_not_found: 'Игрок не найден'
}

export async function referralRoutes(app: FastifyInstance) {
	// Статистика приглашений + доначисление бонусов за оборот друзей.
	app.get('/', { preHandler: [(app as any).authenticate] }, async (request) => {
		const user = await getAuthUser(request)
		await resolveBotInfo()
		let milestones = { paid: 0, count: 0 }
		try { milestones = await payReferralMilestones(user.id) } catch (err: any) {
			request.log?.warn({ err }, 'referral milestones skipped')
		}
		try {
			const stats = await referralStats(user.id)
			const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
			return { ...stats, balance: Number(fresh.balance), milestonesPaid: milestones }
		} catch (err: any) {
			request.log?.warn({ err }, 'referrals fallback empty')
			const { inviteLink } = await import('../utils/referrals.js')
			const link = inviteLink(user)
			return {
				link: link.url,
				code: link.code,
				configured: link.configured,
				playerId: user.playerId,
				rewards: { inviter: 0, invitee: 0, weekSharePct: 0.5 },
				invitedCount: 0,
				totalEarned: 0,
				inviter: null,
				friends: [],
				balance: Number(user.balance),
				milestonesPaid: milestones
			}
		}
	})

	// Применить код приглашения (из start_param или введённый вручную).
	app.post('/attach', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		const parsed = z.object({ code: z.string().min(1) }).safeParse(request.body)
		if (!parsed.success) return reply.code(400).send({ error: 'Введите код или ID пригласившего' })

		const result = await attachReferral(user.id, parsed.data.code)
		if (!result.ok) {
			return reply.code(400).send({ error: REASONS[result.reason] || 'Не удалось применить код', reason: result.reason })
		}

		const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
		return { ok: true, bonus: result.bonus, referrer: result.referrer, balance: Number(fresh.balance) }
	})
}
