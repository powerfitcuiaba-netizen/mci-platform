const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

async function list(userId) {
  const items = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' }
  });
  const unreadCount = items.filter(item => !item.isRead).length;
  return { items, unreadCount };
}

async function markRead(id, userId) {
  const item = await prisma.notification.findFirst({ where: { id, userId } });
  if (!item) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notificação não encontrada');
  return prisma.notification.update({ where: { id }, data: { isRead: true } });
}

async function markAllRead(userId) {
  await prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
  return { success: true };
}

async function createForUser(userId, message, meta = {}) {
  const title = meta.title || 'Atualização';
  const type = meta.type || 'INFO';
  return prisma.notification.create({ data: { userId, title, message, type } });
}

module.exports = { list, markRead, markAllRead, createForUser };
