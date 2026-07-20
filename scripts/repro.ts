import { PrismaClient } from "@prisma/client";
import { transferMoney } from "../src/app/actions/transfer";

const prisma = new PrismaClient();

type TransferInput = {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
};

// Точна копія оригінальної версії transferMoney до фіксу.
// Тримається тут окремо, лише для демонстрації - не є частиною застосунку
// Дозволяє прогнати кожен сценарій "до" в цьому ж запуску скрипта для підтвердження фіксу.
async function buggyTransferMoney(input: TransferInput) {
  const { fromAccountId, toAccountId, amount } = input;

  const from = await prisma.account.findUnique({
    where: { id: fromAccountId },
  });
  const to = await prisma.account.findUnique({ where: { id: toAccountId } });

  if (!from || !to) {
    throw new Error("Account not found");
  }

  try {
    await prisma.account.update({
      where: { id: fromAccountId },
      data: { balance: from.balance - amount },
    });

    await prisma.account.update({
      where: { id: toAccountId },
      data: { balance: to.balance + amount },
    });

    await prisma.transfer.create({
      data: { fromAccountId, toAccountId, amount },
    });

    // revalidatePath у оригіналі викликався тут - у скрипті поза Next.js
    // runtime він завжди впав би, тому свідомо пропущений, щоб не заважати
    // демонстрації самої бізнес-логіки бага.

    return { success: true };
  } catch (e) {
    console.log("Transfer failed", input, e);
    return { success: true }; // завжди true, навіть при помилці
  }
}

async function reset() {
  await prisma.transfer.deleteMany();
  await prisma.account.deleteMany();
  await prisma.account.createMany({
    data: [
      {
        id: "acc-alice",
        userId: "user-1",
        ownerName: "Alice",
        balance: 1000,
        currency: "USD",
      },
      {
        id: "acc-bob",
        userId: "user-2",
        ownerName: "Bob",
        balance: 500,
        currency: "USD",
      },
      {
        id: "acc-carol",
        userId: "user-3",
        ownerName: "Carol",
        balance: 0,
        currency: "EUR",
      },
    ],
  });
}

async function balances() {
  const accs = await prisma.account.findMany({ orderBy: { ownerName: "asc" } });
  return Object.fromEntries(accs.map((a) => [a.ownerName, a.balance]));
}

async function runScenario(title: string, input: TransferInput, note: string) {
  console.log(`\n=== ${title} ===`);
  console.log(note);

  // --- ДО фіксу (баганий код) ---
  await reset();
  const buggyResult = await buggyTransferMoney(input);
  const buggyBalances = await balances();
  console.log(
    "[ДО фіксу]\tРезультат:",
    buggyResult,
    "| Баланси:",
    buggyBalances,
  );

  // --- ПІСЛЯ фіксу (поточна transferMoney з actions/transfer.ts) ---
  await reset();
  const fixedResult = await transferMoney(input);
  const fixedBalances = await balances();
  console.log(
    "[ПІСЛЯ фіксу]\tРезультат:",
    fixedResult,
    "| Баланси:",
    fixedBalances,
  );
}

async function main() {
  await reset();
  console.log("=== Початкові баланси ===");
  console.log(await balances());
  console.log("Саме Alice є авторизованим користувачем у системі (user-1).");

  await runScenario(
    "Сценарій 1: Достатність коштів (Alice -> Bob, 999999 USD)",
    { fromAccountId: "acc-alice", toAccountId: "acc-bob", amount: 999999 },
    "Очікування: до фіксу баланс Alice йде у глибокий мінус; після фіксу - success: false, баланси не змінюються.",
  );

  await runScenario(
    "Сценарій 2: Валідація суми (Alice -> Bob, -500 USD)",
    { fromAccountId: "acc-alice", toAccountId: "acc-bob", amount: -500 },
    "Очікування: до фіксу баланс Alice парадоксально ЗРОСТАЄ (мінус на мінус), Bob втрачає гроші; після фіксу - відмова.",
  );

  await runScenario(
    "Сценарій 3: Авторизація (сесія Alice, переказ з рахунку Bob)",
    { fromAccountId: "acc-bob", toAccountId: "acc-alice", amount: 100 },
    "Очікування: до фіксу переказ проходить, хоча Alice не власниця acc-bob (крадіжка); після фіксу - Unauthorized.",
  );

  await runScenario(
    "Сценарій 4: Переказ самому собі (Alice -> Alice)",
    { fromAccountId: "acc-alice", toAccountId: "acc-alice", amount: 100 },
    "Очікування: до фіксу через застарілий 'to' у пам'яті переказ ефективно ДОДАЄ гроші з нізвідки; після фіксу - відмова.",
  );

  await runScenario(
    "Сценарій 5: Валюта (Alice [USD] -> Carol [EUR])",
    { fromAccountId: "acc-alice", toAccountId: "acc-carol", amount: 100 },
    "Очікування: до фіксу 100 USD перетворюються на 100 EUR 1:1 без конвертації; після фіксу - відмова.",
  );

  await runScenario(
    "Сценарій 6: Валідний переказ (Alice -> Bob, 150 USD)",
    { fromAccountId: "acc-alice", toAccountId: "acc-bob", amount: 150 },
    "Очікування: і до, і після фіксу переказ має пройти успішно (Alice=850, Bob=650) - легітимний шлях не має ламатись.",
  );

  // Race condition - окремо, бо тут потрібні два паралельні виклики
  console.log(
    "\n=== Сценарій 7: Race condition (два одночасні перекази з Alice) ===",
  );
  console.log("Alice має 1000. Одночасно два перекази по 700 на Bob.");

  await reset();
  const [buggyA, buggyB] = await Promise.all([
    buggyTransferMoney({
      fromAccountId: "acc-alice",
      toAccountId: "acc-bob",
      amount: 700,
    }),
    buggyTransferMoney({
      fromAccountId: "acc-alice",
      toAccountId: "acc-bob",
      amount: 700,
    }),
  ]);
  console.log(
    "[ДО фіксу] Результати:",
    buggyA,
    buggyB,
    "| Баланси:",
    await balances(),
  );
  console.log(
    "(обидва читають старий баланс 1000 паралельно - списання втрачається/дублюється,",
  );
  console.log(
    "два записи Transfer по 700 в історії не відповідають реальній зміні балансу)\n",
  );

  await reset();
  const [fixedA, fixedB] = await Promise.all([
    transferMoney({
      fromAccountId: "acc-alice",
      toAccountId: "acc-bob",
      amount: 700,
    }),
    transferMoney({
      fromAccountId: "acc-alice",
      toAccountId: "acc-bob",
      amount: 700,
    }),
  ]);
  console.log(
    "[ПІСЛЯ фіксу]  Результати:",
    fixedA,
    fixedB,
    "| Баланси:",
    await balances(),
  );
  console.log("(рівно один переказ проходить, другий коректно відхиляється.)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
