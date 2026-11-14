pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/sha256/sha256.circom";
include "lib/merkle.circom";
include "lib/sha256var.circom";
include "lib/window.circom";
include "lib/rsa.circom";

template AsciiDigit() {
    signal input in;
    signal output out;
    out <== in - 48;
    component bits = Num2Bits(4);
    bits.in <== out;
    component lt = LessThan(4);
    lt.in[0] <== out;
    lt.in[1] <== 10;
    lt.out === 1;
}

template AsciiDate() {
    signal input in[6];
    signal output value;
    signal output yy;
    component d[6];
    var acc = 0;
    for (var i = 0; i < 6; i++) {
        d[i] = AsciiDigit();
        d[i].in <== in[i];
        acc = acc * 10 + d[i].out;
    }
    value <== acc;
    yy <== d[0].out * 10 + d[1].out;
}

template HashBitsToBytes() {
    signal input in[256];
    signal output out[32];
    component b2n[32];
    for (var i = 0; i < 32; i++) {
        b2n[i] = Bits2Num(8);
        for (var j = 0; j < 8; j++) {
            b2n[i].in[7 - j] <== in[i * 8 + j];
        }
        out[i] <== b2n[i].out;
    }
}

template KeyLeaf(n, k) {
    signal input modulus[k];
    signal output out;

    var pairs = (k + 1) \ 2;
    component hash = Poseidon(pairs);
    for (var i = 0; i < pairs; i++) {
        if (2 * i + 1 < k) {
            hash.inputs[i] <== modulus[2 * i] + (1 << n) * modulus[2 * i + 1];
        } else {
            hash.inputs[i] <== modulus[2 * i];
        }
    }
    out <== hash.out;
}

template Register(keyDepth, maxEcBlocks, maxSaBlocks, n, k) {
    signal input passport_nullifier;
    signal input commitment;
    signal input election_id;
    signal input current_date;
    signal input trusted_key_root;

    signal input dg1[93];
    signal input econtent[maxEcBlocks * 64];
    signal input econtent_blocks;
    signal input dg1_hash_offset;
    signal input signed_attrs[maxSaBlocks * 64];
    signal input signed_attrs_blocks;
    signal input econtent_hash_offset;
    signal input signature[k];
    signal input modulus[k];
    signal input rsa_quotients[17][k];
    signal input rsa_remainders[16][k];
    signal input key_path_elements[keyDepth];
    signal input key_path_index[keyDepth];
    signal input secret;
    signal input nullifier_key;

    component dg1Bits[93];
    component dg1Sha = Sha256(93 * 8);
    for (var i = 0; i < 93; i++) {
        dg1Bits[i] = Num2Bits(8);
        dg1Bits[i].in <== dg1[i];
        for (var j = 0; j < 8; j++) {
            dg1Sha.in[i * 8 + j] <== dg1Bits[i].out[7 - j];
        }
    }
    component dg1Hash = HashBitsToBytes();
    dg1Hash.in <== dg1Sha.out;

    component ecSha = Sha256Var(maxEcBlocks);
    ecSha.in <== econtent;
    ecSha.blocks <== econtent_blocks;
    component ecHash = HashBitsToBytes();
    ecHash.in <== ecSha.out;

    component ecOffsetInside = LessEqThan(16);
    ecOffsetInside.in[0] <== dg1_hash_offset + 32;
    ecOffsetInside.in[1] <== econtent_blocks * 64;
    ecOffsetInside.out === 1;
    component ecWindow = ByteWindow(maxEcBlocks * 64, 32);
    ecWindow.in <== econtent;
    ecWindow.offset <== dg1_hash_offset;
    for (var i = 0; i < 32; i++) {
        ecWindow.out[i] === dg1Hash.out[i];
    }

    component saSha = Sha256Var(maxSaBlocks);
    saSha.in <== signed_attrs;
    saSha.blocks <== signed_attrs_blocks;

    component saOffsetInside = LessEqThan(16);
    saOffsetInside.in[0] <== econtent_hash_offset + 32;
    saOffsetInside.in[1] <== signed_attrs_blocks * 64;
    saOffsetInside.out === 1;
    component saWindow = ByteWindow(maxSaBlocks * 64, 32);
    saWindow.in <== signed_attrs;
    saWindow.offset <== econtent_hash_offset;
    for (var i = 0; i < 32; i++) {
        saWindow.out[i] === ecHash.out[i];
    }

    component rsa = RsaSha256Verify(n, k);
    rsa.signature <== signature;
    rsa.modulus <== modulus;
    rsa.quotients <== rsa_quotients;
    rsa.remainders <== rsa_remainders;
    rsa.hash <== saSha.out;

    component keyLeaf = KeyLeaf(n, k);
    keyLeaf.modulus <== modulus;
    component keyTree = MerkleRoot(keyDepth);
    keyTree.leaf <== keyLeaf.out;
    keyTree.path_elements <== key_path_elements;
    keyTree.path_index <== key_path_index;
    keyTree.root === trusted_key_root;

    dg1[59] === 85;
    dg1[60] === 83;
    dg1[61] === 65;

    component curBits = Num2Bits(20);
    curBits.in <== current_date;

    component dob = AsciiDate();
    component exp = AsciiDate();
    for (var i = 0; i < 6; i++) {
        dob.in[i] <== dg1[62 + i];
        exp.in[i] <== dg1[70 + i];
    }

    component notExpired = GreaterEqThan(20);
    notExpired.in[0] <== exp.value;
    notExpired.in[1] <== current_date;
    notExpired.out === 1;

    signal cur_yy;
    signal cur_mmdd;
    cur_yy <-- current_date \ 10000;
    cur_mmdd <-- current_date % 10000;
    current_date === cur_yy * 10000 + cur_mmdd;
    component yyBits = Num2Bits(7);
    yyBits.in <== cur_yy;
    component yyLt = LessThan(7);
    yyLt.in[0] <== cur_yy;
    yyLt.in[1] <== 100;
    yyLt.out === 1;
    component mmddBits = Num2Bits(14);
    mmddBits.in <== cur_mmdd;
    component mmddLt = LessThan(14);
    mmddLt.in[0] <== cur_mmdd;
    mmddLt.in[1] <== 10000;
    mmddLt.out === 1;

    component born1900s = GreaterThan(7);
    born1900s.in[0] <== dob.yy;
    born1900s.in[1] <== cur_yy;
    signal full_dob;
    full_dob <== 20000000 - born1900s.out * 1000000 + dob.value;
    component adult = LessEqThan(26);
    adult.in[0] <== full_dob + 180000;
    adult.in[1] <== 20000000 + current_date;
    adult.out === 1;

    component hi = Bits2Num(128);
    component lo = Bits2Num(128);
    for (var i = 0; i < 128; i++) {
        hi.in[127 - i] <== saSha.out[i];
        lo.in[127 - i] <== saSha.out[128 + i];
    }
    component pn = Poseidon(3);
    pn.inputs[0] <== hi.out;
    pn.inputs[1] <== lo.out;
    pn.inputs[2] <== election_id;
    pn.out === passport_nullifier;

    component cm = Poseidon(3);
    cm.inputs[0] <== secret;
    cm.inputs[1] <== nullifier_key;
    cm.inputs[2] <== election_id;
    cm.out === commitment;
}
