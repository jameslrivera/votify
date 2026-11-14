pragma circom 2.1.6;

include "circomlib/circuits/bitify.circom";

template LimbRange(n, k) {
    signal input in[k];
    component bits[k];
    for (var i = 0; i < k; i++) {
        bits[i] = Num2Bits(n);
        bits[i].in <== in[i];
    }
}

template ModMul(n, k) {
    signal input a[k];
    signal input b[k];
    signal input modulus[k];
    signal input quotient[k];
    signal input remainder[k];

    assert(k <= 32);
    assert(2 * n + 8 < 253);

    component quotientRange = LimbRange(n, k);
    quotientRange.in <== quotient;
    component remainderRange = LimbRange(n, k);
    remainderRange.in <== remainder;

    signal ab[k][k];
    signal qm[k][k];
    for (var i = 0; i < k; i++) {
        for (var j = 0; j < k; j++) {
            ab[i][j] <== a[i] * b[j];
            qm[i][j] <== quotient[i] * modulus[j];
        }
    }

    var columns = 2 * k - 1;
    var carryBits = n + 6;
    signal difference[columns];
    signal carry[columns];
    component carryRange[columns];

    for (var c = 0; c < columns; c++) {
        var sum = 0;
        for (var i = 0; i < k; i++) {
            var j = c - i;
            if (j >= 0 && j < k) {
                sum += ab[i][j] - qm[i][j];
            }
        }
        if (c < k) {
            sum -= remainder[c];
        }
        difference[c] <== sum;

        var incoming = 0;
        if (c > 0) {
            incoming = carry[c - 1] - (1 << carryBits);
        }
        carry[c] <-- (difference[c] + incoming + (1 << (carryBits + n))) \ (1 << n);
        difference[c] + incoming === (carry[c] - (1 << carryBits)) * (1 << n);
        carryRange[c] = Num2Bits(carryBits + 1);
        carryRange[c].in <== carry[c];
    }
    carry[columns - 1] === 1 << carryBits;
}

template RsaSha256Verify(n, k) {
    signal input signature[k];
    signal input modulus[k];
    signal input quotients[17][k];
    signal input remainders[16][k];
    signal input hash[256];

    assert(n * k >= 2048);

    component signatureRange = LimbRange(n, k);
    signatureRange.in <== signature;
    component modulusRange = LimbRange(n, k);
    modulusRange.in <== modulus;

    component square[16];
    for (var i = 0; i < 16; i++) {
        square[i] = ModMul(n, k);
        square[i].modulus <== modulus;
        square[i].quotient <== quotients[i];
        square[i].remainder <== remainders[i];
        if (i == 0) {
            square[i].a <== signature;
            square[i].b <== signature;
        } else {
            square[i].a <== remainders[i - 1];
            square[i].b <== remainders[i - 1];
        }
    }

    var digestInfo = 0x3031300d060960864801650304020105000420;
    component last = ModMul(n, k);
    last.a <== remainders[15];
    last.b <== signature;
    last.modulus <== modulus;
    last.quotient <== quotients[16];
    for (var i = 0; i < k; i++) {
        var limb = 0;
        for (var j = 0; j < n; j++) {
            var position = i * n + j;
            if (position < 256) {
                limb += hash[255 - position] * (1 << j);
            } else if (position < 408) {
                limb += ((digestInfo >> (position - 256)) & 1) * (1 << j);
            } else if (position >= 416 && position < 2032) {
                limb += 1 << j;
            } else if (position == 2032) {
                limb += 1 << j;
            }
        }
        last.remainder[i] <== limb;
    }
}
