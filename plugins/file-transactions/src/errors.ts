// tslint:disable:max-classes-per-file
import { Errors } from "@arkecosystem/core-transactions";
import { Managers } from "@arkecosystem/crypto";

export class IpfsHashAlreadyExists extends Errors.TransactionError {
    constructor() {
        super(`Failed to apply transaction: this IPFS hash is already registered.`);
    }
}

export class FileKeyInvalid extends Errors.TransactionError {
    constructor() {
        super(`Failed to apply transaction: Invalid IPFS Key.`);
    }
}

export class SenderNotDelegate extends Errors.TransactionError {
    constructor() {
        super(`Failed to apply transaction: Sender must be a delegate.`);
    }
}

export class InvalidMultiHash extends Errors.TransactionError {
    constructor() {
        super(`Failed to apply transaction: Invalid Multihash.`);
    }
}

export class SenderNotActiveDelegate extends Errors.TransactionError {
    constructor() {
        super(
            `Failed to apply transaction: Sender must be active validator or pay minimum transaction fee of ${Managers.configManager.getMilestone()
                .fees.specialFees.setFile / 1e8}.`,
        );
    }
}
