import "dotenv/config";
import { createPublicClient, http, parseAbi } from "viem";
import {
  Chains,
  SupportedChainId,
  isSupportedChain,
} from "../perennial/constants/network";
import {
  MarketSnapshot,
  UserMarketSnapshot,
  fetchMarketSnapshots2,
} from "../perennial/libs/markets";
import { calcMakerExposure } from "../perennial/utils/positionUtils";
import {
  Big6Math,
  formatBig6,
  formatBig6USDPrice,
} from "../perennial/utils/big6Utils";
import { set } from "date-fns";
import { MarketAbi } from "../perennial/abi/Market.abi";

// Alchemy Key
const AlchemyProdKey = process.env.ALCHEMY_KEY;
if (!AlchemyProdKey) throw new Error("Missing alchemy key configuration");

const chainId = (process.env.CHAIN_ID &&
  parseInt(process.env.CHAIN_ID)) as SupportedChainId;
if (chainId && !isSupportedChain(chainId)) throw new Error("Unsupported Chain");
const chain = Chains[chainId];

const userAddress = process.env.USER_ADDRESS as `0x${string}`;
if (!userAddress) throw new Error("Missing user address configuration");

// Create Public Client
const publicClient = createPublicClient({
  chain,
  transport: http(`https://arb-goerli.g.alchemy.com/v2/${AlchemyProdKey}`, {
    batch: true,
  }),
});

// Run main loop
const main = async () => {
  // Fetch Global & User Market Snapshot
  const marketInfo = await fetchMarketSnapshots2(publicClient, userAddress);
  if (!marketInfo) throw new Error("No market info found");

  // Filter out user positions with no exposure
  const marketsWithUserPositions =
    marketInfo.user &&
    (Object.entries(marketInfo.user)
      .filter(([market, position]) => position.side !== "none")
      .reduce(
        (acc, [market, position]) => ({ ...acc, [market]: position }),
        {}
      ) as Record<string, UserMarketSnapshot>);

  if (!marketsWithUserPositions) throw new Error("No user positions found");

  // Filter out market snapshots without users positions
  const relevantGlobalMarkets =
    marketInfo.market &&
    (Object.entries(marketInfo.market)
      .filter(([market, position]) =>
        Object.keys(marketsWithUserPositions).includes(market)
      )
      .reduce(
        (acc, [market, position]) => ({ ...acc, [market]: position }),
        {}
      ) as Record<string, MarketSnapshot>);

  if (!relevantGlobalMarkets)
    throw new Error("No relevant global markets found");

  /// Detailed USER & MARKET info 👇
  // console.log(marketsWithUserPositions);
  // console.log(relevantGlobalMarkets);

  // Parse Market Info into readable format
  const parsedMarketInfo = Object.keys(relevantGlobalMarkets).map((key) => {
    return {
      ...calculateMarketStatistics(
        relevantGlobalMarkets[key].latestOracleVersion.price,
        {
          userMaker: marketsWithUserPositions[key].nextPosition.maker, // NOTE: DIFFERENT CONST
          globalMaker: relevantGlobalMarkets[key].nextPosition.maker,
          globalLong: relevantGlobalMarkets[key].nextPosition.long,
          globalShort: relevantGlobalMarkets[key].nextPosition.short,
        },
        marketsWithUserPositions[key].local.collateral,
        marketsWithUserPositions[key].nextLeverage
      ),
      market: key,
    };
  });

  // Print Maker Exposure
  parsedMarketInfo.forEach((market) => {
    console.log(`------ ${market.market.toUpperCase()} ------`);
    console.log("Market Price: ", market.usdPrice);

    console.log(`User collateral: ${market.collateral} USDC`);
    console.log(
      `User maker position: ${market.maker} ${market.market.toUpperCase()}`
    );
    console.log(`User maker leverage: ${market.leverage}x`);
    console.log(
      `User maker exposure: ${market.makerExposure} ${market.market}`
    );
    console.log("");
  });

  /// Return relevant markets so we cna watch them
  return marketsWithUserPositions;
};

// Do the math
const calculateMarketStatistics = (
  price: bigint,
  position: {
    userMaker: bigint;
    globalMaker: bigint;
    globalLong: bigint;
    globalShort: bigint;
  },
  collateral: bigint,
  leverage: bigint
) => {
  // Maker exposure in units of payoff
  const makerExposure = calcMakerExposure(
    position.userMaker,
    position.globalMaker,
    position.globalLong,
    position.globalShort
  );

  // Maker exposure in units of USD
  const usdMakerExposure =
    Big6Math.toUnsafeFloat(makerExposure) * Big6Math.toUnsafeFloat(price);

  return {
    price,
    usdPrice: formatBig6USDPrice(price),
    maker: formatBig6(position.userMaker, { numSigFigs: 6 }),
    makerExposure: formatBig6(makerExposure, { numSigFigs: 6 }),
    collateral: formatBig6USDPrice(collateral),
    leverage: Big6Math.toFloatString(leverage),
  };
};

const setup = async () => {
  console.log("🌸 Perennial v2 - Maker Exposure");
  console.log(`Watching ${userAddress} `);
  console.log(`Chain: ${chain.name} (${chain.id})`);
  console.log("");

  // Run main loop
  console.log("Fetching user markets...");
  console.log("");

  // Fetch Market info onload
  const markets = await main();

  console.log(
    `Watching ${Object.keys(markets).join(" , ")} market${
      Object.keys(markets).length > 1 ? "s" : ""
    } for updates...`
  );
  console.log("");

  const unwatch = publicClient.watchContractEvent({
    address: Object.values(markets).map((market) => market.market),
    abi: MarketAbi,
    eventName: "Updated",
    onLogs: (logs) => {
      console.log("Detected Updated Position");
      main();
    },
  });
};

// Start program
setup();
