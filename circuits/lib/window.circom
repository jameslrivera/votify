pragma circom 2.1.6;

include "circomlib/circuits/comparators.circom";

template ByteWindow(length, size) {
    signal input in[length];
    signal input offset;
    signal output out[size];

    var positions = length - size + 1;
    component isStart[positions];
    var matches = 0;
    for (var i = 0; i < positions; i++) {
        isStart[i] = IsEqual();
        isStart[i].in[0] <== offset;
        isStart[i].in[1] <== i;
        matches += isStart[i].out;
    }
    matches === 1;

    signal term[positions][size];
    for (var j = 0; j < size; j++) {
        var sum = 0;
        for (var i = 0; i < positions; i++) {
            term[i][j] <== isStart[i].out * in[i + j];
            sum += term[i][j];
        }
        out[j] <== sum;
    }
}
