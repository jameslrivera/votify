import constants from "../../../constants.json" with { type: "json" };

export const TREE_DEPTH: number = constants.TREE_DEPTH;
export const KEY_TREE_DEPTH: number = constants.KEY_TREE_DEPTH;
export const MAX_OPTIONS: number = constants.MAX_OPTIONS;

export const RSA_LIMB_BITS: number = constants.RSA_LIMB_BITS;
export const RSA_LIMBS: number = constants.RSA_LIMBS;
export const MAX_ECONTENT_PADDED: number = constants.MAX_ECONTENT_PADDED;
export const MAX_SIGNED_ATTRS_PADDED: number = constants.MAX_SIGNED_ATTRS_PADDED;
export const DG1_LENGTH: number = constants.DG1_LENGTH;

export const BN254_FR =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const BN254_FQ =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export const CREDENTIAL_PREFIX = "zkv1:";
export const SECRET_BYTES = 31;
