import { BigNumber } from '@ethersproject/bignumber'

import Board from '../board'
import { UNIT, ZERO_BN } from '../constants/bn'
import { DataSource, DEFAULT_ITERATIONS } from '../constants/contracts'
import Market from '../market'
import Option from '../option'
import Strike from '../strike'
import { getDelta, getGamma, getRho, getTheta, getVega } from '../utils/blackScholes'
import fromBigNumber from '../utils/fromBigNumber'
import getBreakEvenPrice from '../utils/getBreakEvenPrice'
import getTimeToExpiryAnnualized from '../utils/getTimeToExpiryAnnualized'
import toBigNumber from '../utils/toBigNumber'
import getQuoteDisabledReason from './getQuoteDisabledReason'
import getQuoteIteration from './getQuoteIteration'

export enum QuoteDisabledReason {
  EmptySize = 'EmptySize',
  Expired = 'Expired',
  TradingCutoff = 'TradingCutoff',
  InsufficientLiquidity = 'InsufficientLiquidity',
  DeltaOutOfRange = 'DeltaOutOfRange',
  VolTooHigh = 'VolTooHigh',
  VolTooLow = 'VolTooLow',
  IVTooHigh = 'IVTooHigh',
  IVTooLow = 'IVTooLow',
  SkewTooHigh = 'SkewTooHigh',
  SkewTooLow = 'SkewTooLow',
}

export type QuoteIteration = {
  premium: BigNumber
  optionPriceFee: BigNumber
  spotPriceFee: BigNumber
  vegaUtilFee: QuoteVegaUtilFeeComponents
  varianceFee: QuoteVarianceFeeComponents
  forceClosePenalty: BigNumber
  volTraded: BigNumber
  newBaseIv: BigNumber
  newSkew: BigNumber
  postTradeAmmNetStdVega: BigNumber
}

export type QuoteFeeComponents = {
  optionPriceFee: BigNumber
  spotPriceFee: BigNumber
  vegaUtilFee: BigNumber
  varianceFee: BigNumber
}

export type QuoteVarianceFeeComponents = {
  varianceFeeCoefficient: BigNumber
  vega: BigNumber
  vegaCoefficient: BigNumber
  skew: BigNumber
  skewCoefficient: BigNumber
  ivVariance: BigNumber
  ivVarianceCoefficient: BigNumber
  varianceFee: BigNumber
}

export type QuoteVegaUtilFeeComponents = {
  preTradeAmmNetStdVega: BigNumber
  postTradeAmmNetStdVega: BigNumber
  vegaUtil: BigNumber
  volTraded: BigNumber
  NAV: BigNumber
  vegaUtilFee: BigNumber
}

export type QuoteGreeks = {
  delta: BigNumber
  vega: BigNumber
  gamma: BigNumber
  rho: BigNumber
  theta: BigNumber
}

export type QuoteOptions = {
  isForceClose?: boolean
  iterations?: number
}

export default class Quote {
  private __option: Option
  __source = DataSource.ContractCall
  isBuy: boolean
  size: BigNumber
  pricePerOption: BigNumber
  premium: BigNumber
  fee: BigNumber
  feeComponents: QuoteFeeComponents
  iv: BigNumber
  greeks: QuoteGreeks
  forceClosePenalty: BigNumber
  isForceClose: boolean
  breakEven: BigNumber
  isDisabled: boolean
  disabledReason: QuoteDisabledReason | null

  iterations: QuoteIteration[]

  constructor(option: Option, isBuy: boolean, size: BigNumber, options?: QuoteOptions) {
    this.__option = option
    this.isBuy = isBuy
    this.size = size

    const fields = this.getFields(option, isBuy, size, options)
    this.pricePerOption = fields.pricePerOption
    this.premium = fields.premium
    this.fee = fields.fee
    this.feeComponents = fields.feeComponents
    this.iv = fields.iv
    this.greeks = fields.greeks
    this.forceClosePenalty = fields.forceClosePenalty
    this.isForceClose = fields.isForceClose
    this.isDisabled = !!fields.disabledReason
    this.disabledReason = fields.disabledReason
    this.breakEven = fields.breakEven
    this.iterations = fields.iterations
  }

  private getDisabledFields(option: Option, disabledReason: QuoteDisabledReason) {
    const vol = option.strike().skew.mul(option.board().baseIv).div(UNIT)
    return {
      pricePerOption: ZERO_BN,
      premium: ZERO_BN,
      iv: vol,
      fee: ZERO_BN,
      feeComponents: {
        optionPriceFee: ZERO_BN,
        spotPriceFee: ZERO_BN,
        vegaUtilFee: ZERO_BN,
        varianceFee: ZERO_BN,
      },
      greeks: {
        delta: option.delta,
        vega: option.strike().vega,
        gamma: option.strike().gamma,
        theta: option.theta,
        rho: option.rho,
      },
      isForceClose: false,
      forceClosePenalty: ZERO_BN,
      isDisabled: !!disabledReason,
      disabledReason,
      breakEven: ZERO_BN,
      iterations: [],
    }
  }

  private getFields(
    option: Option,
    isBuy: boolean,
    size: BigNumber,
    options?: QuoteOptions
  ): {
    pricePerOption: BigNumber
    premium: BigNumber
    iv: BigNumber
    fee: BigNumber
    feeComponents: QuoteFeeComponents
    greeks: QuoteGreeks
    isForceClose: boolean
    forceClosePenalty: BigNumber
    isDisabled: boolean
    disabledReason: QuoteDisabledReason | null
    breakEven: BigNumber
    iterations: QuoteIteration[]
  } {
    const numIterations = options?.iterations ?? DEFAULT_ITERATIONS
    if (numIterations < 1) {
      throw new Error('Iterations must be greater than or equal to 1')
    }

    const isForceClose = options?.isForceClose ?? false

    const board = option.board()
    const strike = option.strike()
    const marketView = option.market().__marketData
    const isCall = option.isCall

    let baseIv = board.baseIv
    let skew = strike.skew
    let preTradeAmmNetStdVega = marketView.globalNetGreeks.netStdVega.mul(-1)

    const iterationSize = size.div(numIterations)
    const iterations = []

    for (let i = 0; i < numIterations; i++) {
      const quote = getQuoteIteration({
        option,
        isBuy,
        size: iterationSize,
        baseIv,
        skew,
        netStdVega: marketView.globalNetGreeks.netStdVega,
        preTradeAmmNetStdVega,
        isForceClose,
      })
      iterations.push(quote)

      // Update skew, IV, AMM net std vega
      baseIv = quote.newBaseIv
      skew = quote.newSkew
      preTradeAmmNetStdVega = quote.postTradeAmmNetStdVega
    }

    const newIv = baseIv.mul(skew).div(UNIT)
    const spotPrice = option.market().spotPrice
    const strikePrice = option.strike().strikePrice
    const rate = option.market().__marketData.marketParameters.greekCacheParams.rateAndCarry

    const disabledReason = getQuoteDisabledReason(
      option.strike(),
      size,
      ZERO_BN,
      newIv,
      skew,
      baseIv,
      isBuy,
      isForceClose
    )
    if (disabledReason) {
      return this.getDisabledFields(option, disabledReason)
    }

    const timeToExpiryAnnualized = getTimeToExpiryAnnualized(option.board())

    const delta = toBigNumber(
      getDelta(
        timeToExpiryAnnualized,
        fromBigNumber(newIv),
        fromBigNumber(spotPrice),
        fromBigNumber(strikePrice),
        fromBigNumber(rate),
        isCall
      )
    )

    const vega = toBigNumber(
      getVega(
        timeToExpiryAnnualized,
        fromBigNumber(newIv),
        fromBigNumber(spotPrice),
        fromBigNumber(strikePrice),
        fromBigNumber(rate)
      )
    )

    const gamma = toBigNumber(
      getGamma(
        timeToExpiryAnnualized,
        fromBigNumber(newIv),
        fromBigNumber(spotPrice),
        fromBigNumber(strikePrice),
        fromBigNumber(rate)
      )
    )

    const theta = toBigNumber(
      getTheta(
        timeToExpiryAnnualized,
        fromBigNumber(newIv),
        fromBigNumber(spotPrice),
        fromBigNumber(strikePrice),
        fromBigNumber(rate),
        isCall
      )
    )

    const rho = toBigNumber(
      getRho(
        timeToExpiryAnnualized,
        fromBigNumber(newIv),
        fromBigNumber(spotPrice),
        fromBigNumber(strikePrice),
        fromBigNumber(rate),
        isCall
      )
    )

    // Pricing
    const premium = iterations.reduce((sum, quote) => sum.add(quote.premium), ZERO_BN)
    const pricePerOption = premium.mul(UNIT).div(size)
    const breakEven = getBreakEvenPrice(option.isCall, strike.strikePrice, premium.mul(UNIT).div(size))
    const forceClosePenalty = iterations.reduce((sum, quote) => sum.add(quote.forceClosePenalty), ZERO_BN)

    // Fees
    const optionPriceFee = iterations.reduce((sum, quote) => sum.add(quote.optionPriceFee), ZERO_BN)
    const spotPriceFee = iterations.reduce((sum, quote) => sum.add(quote.spotPriceFee), ZERO_BN)
    const vegaUtilFee = iterations.reduce((sum, quote) => sum.add(quote.vegaUtilFee.vegaUtilFee), ZERO_BN)
    const varianceFee = iterations.reduce((sum, quote) => sum.add(quote.varianceFee.varianceFee), ZERO_BN)
    const fee = optionPriceFee.add(spotPriceFee).add(vegaUtilFee).add(varianceFee)

    return {
      pricePerOption,
      premium,
      fee,
      iv: newIv,
      feeComponents: {
        optionPriceFee,
        spotPriceFee,
        vegaUtilFee,
        varianceFee,
      },
      greeks: {
        delta,
        vega,
        gamma,
        rho,
        theta,
      },
      isForceClose,
      forceClosePenalty,
      isDisabled: false,
      disabledReason: null,
      breakEven,
      iterations,
    }
  }

  // Getters

  static get(option: Option, isBuy: boolean, size: BigNumber, options?: QuoteOptions): Quote {
    return new Quote(option, isBuy, size, options)
  }

  // Edges

  market(): Market {
    return this.__option.market()
  }

  board(): Board {
    return this.__option.board()
  }

  strike(): Strike {
    return this.__option.strike()
  }

  option(): Option {
    return this.__option
  }
}
