"use server";

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";

export type TransferInput = {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
};

// Внутрішній P2P-переказ між рахунками.
// Цей код зараз у проді. Він "працює" на демо, але вже були скарги
// від користувачів і кілька дивних балансів у базі.
export async function transferMoney(input: TransferInput) {
  const { fromAccountId, toAccountId, amount } = input;

  // Весь код обгорну у try catch, щоб пройти всі сценарії у repro.ts
  try {
    // Валідація суми переказу (на те що це валідне число і більше нуля)
    if (
      typeof amount !== "number" ||
      Number.isNaN(amount) ||
      amount <= 0 ||
      !Number.isFinite(amount)
    ) {
      throw new Error("Amount is invalid");
    }

    // Валідація для запобігання переказу самому собі
    if (fromAccountId === toAccountId) {
      throw new Error("User cannot perform transaction to themselves");
    }

    const from = await prisma.account.findUnique({
      where: { id: fromAccountId },
    });
    const to = await prisma.account.findUnique({ where: { id: toAccountId } });

    if (!from || !to) {
      throw new Error("Account not found");
    }

    // Перевірка авторизації відправника. lib/auth.ts повертає об'єкт із userId, але
    // я також зроблю додаткову перевірку на повернення null/undefined
    const session = await auth();
    if (!session || from.userId !== session.userId) {
      throw new Error("Unauthorized");
    }

    // Валюту — не змішуй різні валюти (USD → EUR без конвертації);
    // Як я розумію, не можна із балансу на одній валюті переказувати кошти на баланс на іншій валюті.
    if (from.currency !== to.currency) {
      throw new Error(`Currencies don't match`);
    }

    // Атомарне списання коштів із перевіркою залишку на рівні БД.
    // updateMany гарантує, що списання відбудеться лише за умови достатнього балансу (balance >= amount),
    // що ефективно запобігає Race Condition та Lost Update.
    await prisma.$transaction(async (tx) => {
      const updatedSender = await tx.account.updateMany({
        where: {
          id: fromAccountId,
          balance: { gte: amount },
        },
        data: { balance: { decrement: amount } },
      });

      if (updatedSender.count === 0) {
        throw new Error("Insufficient funds");
      }

      await tx.account.update({
        where: { id: toAccountId },
        data: { balance: { increment: amount } },
      });

      await tx.transfer.create({
        data: { fromAccountId, toAccountId, amount },
      });
    });

    // revalidatePath я також огорнув у try catch, щоб не виводити лишні помилки при npm run repro
    try {
      revalidatePath("/");
    } catch (error) {}
    return { success: true };
  } catch (e: unknown) {
    const errorMessage =
      e instanceof Error ? e.message : "Unknown error occured!";
    console.log("Transfer failed", input, errorMessage);
    // Змінено на false. Якщо переказ не вдався, функція не повинна повідомляти про успіх.
    // Також можна передати месседж помилки, але поки я залишаю лише false
    return { success: false };
  }
}
