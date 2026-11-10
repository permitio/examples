'use client';

import { Empty, Skeleton, Table, type TableColumnsType } from 'antd';
import { useTransactions } from '@/components/TransactionsContext';
import type { TransactionRow } from '@/lib/api-types';

const columns: TableColumnsType<TransactionRow> = [
  {
    title: 'Date',
    dataIndex: 'date',
    key: 'date',
    render: (date: string) => new Date(date).toLocaleString(),
  },
  { title: 'Description', dataIndex: 'description', key: 'description' },
  {
    title: 'Amount',
    key: 'amount',
    align: 'right',
    render: (_: unknown, { amount, currency, direction }: TransactionRow) =>
      `${direction === 'out' ? '-' : '+'}${currency}${amount.toFixed(2)}`,
  },
];

export function Transactions() {
  const { state } = useTransactions();
  switch (state.status) {
    case 'loading':
      return <Skeleton active />;
    case 'forbidden':
      return (
        <p className="text-center text-lg">Not allowed to see this account&apos;s transactions</p>
      );
    case 'failed':
      return <p className="text-center text-lg">The transactions did not load</p>;
    case 'loaded':
      return state.transactions.length === 0 ? (
        <Empty description="No transactions yet" />
      ) : (
        <Table columns={columns} dataSource={state.transactions} rowKey="id" pagination={false} />
      );
  }
}
