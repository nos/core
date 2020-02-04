import { app } from "@arkecosystem/core-container";
import { ApplicationEvents } from "@arkecosystem/core-event-emitter";
import {
    Container,
    Database,
    EventEmitter,
    Logger,
    Shared,
    State,
    TransactionPool,
} from "@arkecosystem/core-interfaces";
import { roundCalculator } from "@arkecosystem/core-utils";
import { Interfaces, Managers, Utils } from "@arkecosystem/crypto";
import { Delegate, q } from "@nosplatform/storage";

const defaults = {};
const emitter = app.resolvePlugin<EventEmitter.EventEmitter>("event-emitter");
const databaseService: Database.IDatabaseService = app.resolvePlugin<Database.IDatabaseService>("database");
const poolService: TransactionPool.IConnection = app.resolvePlugin<TransactionPool.IConnection>("transaction-pool");
const logger: Logger.ILogger = app.resolvePlugin<Logger.ILogger>("logger");

export const plugin: Container.IPluginDescriptor = {
    pkg: require("../package.json"),
    defaults,
    alias: "top-rewards",
    async register(container: Container.IContainer, options) {
        logger.info("Registering Top Rewards plug-in");

        // After state finishes building, apply the topRewards to wallets and cache the last round's blocks.
        emitter.on(ApplicationEvents.StateBuilderFinished, async () => {
            logger.info("Bootstrapping Top Rewards");
            await TopRewards.bootstrap();
            await TopRewards.syncLatestRound();
            logger.info("Bootstrapping Top Rewards Completed");
        });

        // On a new block, handle the cache and top rewards.
        emitter.on(ApplicationEvents.BlockApplied, async (block: Interfaces.IBlockData) => {
            await TopRewards.handleCacheAndTopRewards(block);
            emitter.emit("topRewards.block.applied", block);
        });

        // On a reverted block, handle the cache and top rewards.
        emitter.on(ApplicationEvents.BlockReverted, async (block: Interfaces.IBlockData) => {
            await TopRewards.handleRevertCacheAndTopRewards(block);
            emitter.emit("topRewards.block.reverted", block);
        });
    },
    async deregister(container: Container.IContainer, options) {
        logger.info("Deregistering Top Rewards Plugin");
    },
};

class TopRewards {
    public static topDelegates: string[][] = [];

    // Set the topRewards for the nodes
    public static async bootstrap(publicKey?: string, walletManager?: State.IWalletManager): Promise<void> {
        if (publicKey && walletManager) {
            const dbDelegate: Delegate = await Delegate.findOne({ where: { publicKey } });
            if (dbDelegate) {
                const topReward = Utils.BigNumber.make(dbDelegate.topRewards);
                const delegate = walletManager.findByPublicKey(dbDelegate.publicKey);
                this.addRewards(delegate, topReward, walletManager);
            }
        } else if (!publicKey && !walletManager) {
            const dbDelegates: Delegate[] = await Delegate.find();
            if (dbDelegates.length) {
                for (const dbDel of dbDelegates) {
                    const topReward = Utils.BigNumber.make(dbDel.topRewards);
                    const delegate = databaseService.walletManager.findByPublicKey(dbDel.publicKey);
                    const poolDelegate = poolService.walletManager.findByPublicKey(dbDel.publicKey);
                    this.addRewards(delegate, topReward, databaseService.walletManager);
                    this.addRewards(poolDelegate, topReward, poolService.walletManager);
                }
            }
        } else {
            throw new Error("Top Rewards bootstrap loaded without correct parameters");
        }
    }

    // Setting the top delegates of the latest block's round on bootstrap
    public static async syncLatestRound() {
        const lastBlock: Interfaces.IBlockData = await databaseService.connection.blocksRepository.latest();
        const roundData = roundCalculator.calculateRound(lastBlock.height);
        const newTopDelegates = this.getTopDelegates(roundData);
        if (newTopDelegates) {
            this.topDelegates[roundData.round] = newTopDelegates;
        }
    }

    // Handle caching new top delegates and distribute rewards
    public static async handleCacheAndTopRewards(blockData: Interfaces.IBlockData, bootstrap = false) {
        const roundData = roundCalculator.calculateRound(blockData.height);

        // Only set this block's round's top delegates if not already set
        if (!this.topDelegates[roundData.round]) {
            // Get the top delegates of this round
            const newTopDelegates = this.getTopDelegates(roundData);
            // Store them in session variable
            if (newTopDelegates) {
                this.topDelegates[roundData.round] = newTopDelegates;
            }
        }

        // We use the rounds global var instead of checking isNewRound() because sometimes the sync gets a new round block before all the round's blocks are cached
        const lastRound = roundCalculator.calculateRound(roundData.roundHeight - 1 || 1);
        // Get the previous round's top delegates stored in redis
        const lastTop = this.topDelegates[lastRound.round];
        // If the previous round has top delegates
        if (lastTop && roundData.roundHeight === blockData.height) {
            // Apply top rewards
            const reward = await TopRewards.applyTopRewardsForRound(Number(lastRound.roundHeight), lastTop.join(","));
            // If rewards are distributed, store new delegate stats & fire top rewards event for supply tracker
            if (reward) {
                // Store the rewarded delegates' topRewards state in SQLite for TopRewards.bootstrap()
                q(async () => {
                    for (const publicKey of reward.rewardedDelegates) {
                        const delegate = await this.findOrCreate("Delegate", publicKey);
                        const delegateRewards = Utils.BigNumber.make(
                            databaseService.walletManager
                                .findByPublicKey(publicKey)
                                .getAttribute("delegate.forgedTopRewards"),
                        ).toString();
                        if (delegate.topRewards !== Utils.BigNumber.make(delegateRewards).toString()) {
                            delegate.topRewards = delegateRewards;
                            await delegate.save();
                        }
                    }
                });
                emitter.emit("top.rewards.applied", reward);
                delete this.topDelegates[reward.roundInfo.round];
            }
        }
    }

    public static async applyTopRewardsForRound(
        roundHeight: number,
        lastTop: string,
    ): Promise<{ rewardedDelegates; totalReward; roundInfo; topDelegateReward } | void> {
        const roundInfo = roundCalculator.calculateRound(roundHeight);
        const delegatesCount = roundInfo.maxDelegates;
        const topReward = Managers.configManager.getMilestone(roundInfo.roundHeight).topReward;
        const topDelegatesStr = lastTop;
        if (topDelegatesStr) {
            const topDelegates = topDelegatesStr.split(",");
            const topDelegateReward = Utils.BigNumber.make(topReward)
                .dividedBy(topDelegates.length)
                .times(delegatesCount);
            const rewardedDelegates = [];
            let totalReward = Utils.BigNumber.ZERO;
            if (topDelegates.length) {
                for (const publicKey of topDelegates) {
                    const delegate = databaseService.walletManager.findByPublicKey(publicKey);
                    const poolDelegate = poolService.walletManager.findByPublicKey(publicKey);
                    const delegateLastBlock = delegate.getAttribute("delegate.lastBlock", { height: 0 });
                    if (Number(delegateLastBlock.height) > 0) {
                        const delegateLastRound = roundCalculator.calculateRound(delegateLastBlock.height);
                        if (delegateLastRound.round >= roundInfo.round) {
                            this.addRewards(delegate, topDelegateReward, databaseService.walletManager);
                            this.addRewards(poolDelegate, topDelegateReward, poolService.walletManager);
                            rewardedDelegates.push(publicKey);
                            totalReward = totalReward.plus(topDelegateReward);
                        }
                    }
                }

                return {
                    rewardedDelegates,
                    totalReward,
                    roundInfo,
                    topDelegateReward,
                };
            }
        }
        return undefined;
    }

    public static async revertTopRewardsForRound(
        roundHeight: number,
        lastTop: string,
    ): Promise<{ revertedDelegates; totalReward; roundInfo } | void> {
        const roundInfo = roundCalculator.calculateRound(roundHeight);
        const delegatesCount = roundInfo.maxDelegates;
        const topReward = Managers.configManager.getMilestone(roundHeight).topReward;
        const topDelegatesStr = lastTop;
        if (topDelegatesStr) {
            const topDelegates = topDelegatesStr.split(",");

            const topDelegateReward = Utils.BigNumber.make(topReward)
                .dividedBy(topDelegates.length)
                .times(delegatesCount);

            const revertedDelegates = [];
            let totalReward = Utils.BigNumber.ZERO;
            if (topDelegates.length) {
                for (const publicKey of topDelegates) {
                    const delegate = databaseService.walletManager.findByPublicKey(publicKey);
                    const poolDelegate = poolService.walletManager.findByPublicKey(publicKey);
                    const delegateLastBlock = delegate.getAttribute("delegate.lastBlock", { height: 0 });
                    if (Number(delegateLastBlock.height) > 0) {
                        const delegateLastRound = roundCalculator.calculateRound(delegateLastBlock.height);
                        if (delegateLastRound.round >= roundInfo.round) {
                            this.removeRewards(delegate, topDelegateReward, databaseService.walletManager);
                            this.removeRewards(poolDelegate, topDelegateReward, poolService.walletManager);
                            revertedDelegates.push(publicKey);
                            totalReward = totalReward.plus(topDelegateReward);
                        }
                    }
                }

                return {
                    revertedDelegates,
                    totalReward,
                    roundInfo,
                };
            }
        }
        return undefined;
    }

    // Function to apply top rewards & cache round data
    public static async handleRevertCacheAndTopRewards(blockData: Interfaces.IBlockData, trackSupply: boolean = false) {
        const roundData = roundCalculator.calculateRound(blockData.height);

        // If the reverted block has a top reward and it was a new round block: Revert Top Rewards for last round & cache the new data
        const hasTopReward = !Utils.BigNumber.make(blockData.topReward).isZero();
        if (hasTopReward && (roundData.roundHeight === blockData.height || blockData.height === 2)) {
            // TopDelegates cache is removed after rewards are applied, so we re-retrieve them for the last round and cache them here.
            const lastRound = roundCalculator.calculateRound(roundData.roundHeight - 1);
            const topDelegates = this.getTopDelegates(lastRound);
            // If there are topDelegates for the round we reverted to: revert their rewards
            if (topDelegates) {
                const reward = await TopRewards.revertTopRewardsForRound(lastRound.round, topDelegates.join(","));
                if (reward) {
                    emitter.emit("top.rewards.reverted", reward);
                    if (!trackSupply) {
                        emitter.emit("top.supply.reverted", reward.roundInfo.round);
                    }
                }
            }
        }
    }

    private static addRewards(delegate: State.IWallet, topDelegateReward, walletManager) {
        delegate.balance = delegate.balance.plus(topDelegateReward);
        delegate.setAttribute(
            "delegate.forgedTopRewards",
            delegate
                .getAttribute<Utils.BigNumber>("delegate.forgedTopRewards", Utils.BigNumber.ZERO)
                .plus(topDelegateReward),
        );
        if (delegate.hasVoted()) {
            const votedDelegate: State.IWallet = walletManager.findByPublicKey(delegate.getAttribute("vote"));
            votedDelegate.setAttribute(
                "delegate.voteBalance",
                Utils.BigNumber.make(
                    votedDelegate.getAttribute("delegate.voteBalance").plus(topDelegateReward.toFixed()),
                ),
            );
            walletManager.reindex(votedDelegate);
        }
        walletManager.reindex(delegate);
    }

    private static removeRewards(delegate: State.IWallet, topDelegateReward, walletManager) {
        delegate.balance = delegate.balance.minus(topDelegateReward);
        delegate.setAttribute(
            "delegate.forgedTopRewards",
            delegate.getAttribute("delegate.forgedTopRewards").minus(topDelegateReward.toFixed()),
        );
        if (delegate.hasVoted()) {
            const votedDelegate: State.IWallet = walletManager.findByPublicKey(delegate.getAttribute("vote"));
            votedDelegate.setAttribute(
                "delegate.voteBalance",
                Utils.BigNumber.make(
                    votedDelegate.getAttribute("delegate.voteBalance").minus(topDelegateReward.toFixed()),
                ),
            );
            walletManager.reindex(votedDelegate);
        }
        walletManager.reindex(delegate);
    }

    private static getTopDelegates(roundData: Shared.IRoundInfo) {
        const topDelegateCount = Managers.configManager.getMilestone(roundData.round).topDelegates;
        const topDelegates = [];
        let i = 0;
        let delegates = [];
        const getDelegates = () => {
            let delegates = [];
            try {
                delegates = databaseService.walletManager.loadActiveDelegateList(roundData);
            } catch (e) {
                throw new Error(e);
            }
            return delegates;
        };

        delegates = getDelegates();

        for (const delegate of delegates) {
            if (i < topDelegateCount) {
                topDelegates.push(delegate.publicKey);
            } else {
                break;
            }
            i++;
        }

        return topDelegates;
    }

    private static async findOrCreate(model, id) {
        let res;
        switch (model) {
            case "Delegate":
                let delegate = await Delegate.findOne({ where: { publicKey: id } });
                if (!delegate) {
                    delegate = new Delegate();
                    delegate.publicKey = id;
                    delegate.topRewards = "0";
                }
                res = delegate;
                break;
        }
        return res;
    }
}

export { TopRewards };
