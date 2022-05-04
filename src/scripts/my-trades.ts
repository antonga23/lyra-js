import yargs from 'yargs'

import fromBigNumber from '../utils/fromBigNumber'
import getScriptLyra from './utils/getScriptLyra'

export default async function myTrades(argv: string[]) {
  const { lyra, signer } = getScriptLyra(argv)
  const args = await yargs(argv).options({
    account: { type: 'string', alias: 'a', require: false },
  }).argv
  const trades = await lyra.trades(args.account ?? signer.address)
  console.log(
    trades.map(trade => ({
      id: trade.positionId,
      market: trade.marketName,
      size: fromBigNumber(trade.size),
      isBuy: trade.isBuy,
      pricePerOption: fromBigNumber(trade.pricePerOption),
      premium: fromBigNumber(trade.premium),
      transactionHash: trade.transactionHash,
    }))
  )
}
