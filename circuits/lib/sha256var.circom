pragma circom 2.1.6;

include "circomlib/circuits/sha256/constants.circom";
include "circomlib/circuits/sha256/sha256compression.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

template Sha256Var(maxBlocks) {
    signal input in[maxBlocks * 64];
    signal input blocks;
    signal output out[256];

    component bytes[maxBlocks * 64];
    for (var i = 0; i < maxBlocks * 64; i++) {
        bytes[i] = Num2Bits(8);
        bytes[i].in <== in[i];
    }

    component initial[8];
    for (var j = 0; j < 8; j++) {
        initial[j] = H(j);
    }

    component compress[maxBlocks];
    for (var i = 0; i < maxBlocks; i++) {
        compress[i] = Sha256compression();
        for (var j = 0; j < 8; j++) {
            for (var k = 0; k < 32; k++) {
                if (i == 0) {
                    compress[i].hin[j * 32 + k] <== initial[j].out[k];
                } else {
                    compress[i].hin[j * 32 + k] <== compress[i - 1].out[j * 32 + 31 - k];
                }
            }
        }
        for (var b = 0; b < 64; b++) {
            for (var k = 0; k < 8; k++) {
                compress[i].inp[b * 8 + k] <== bytes[i * 64 + b].out[7 - k];
            }
        }
    }

    component isLast[maxBlocks];
    var matches = 0;
    for (var i = 0; i < maxBlocks; i++) {
        isLast[i] = IsEqual();
        isLast[i].in[0] <== blocks;
        isLast[i].in[1] <== i + 1;
        matches += isLast[i].out;
    }
    matches === 1;

    signal picked[maxBlocks][256];
    for (var k = 0; k < 256; k++) {
        var sum = 0;
        for (var i = 0; i < maxBlocks; i++) {
            picked[i][k] <== isLast[i].out * compress[i].out[k];
            sum += picked[i][k];
        }
        out[k] <== sum;
    }
}
