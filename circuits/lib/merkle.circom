pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

template MerkleRoot(depth) {
    signal input leaf;
    signal input path_elements[depth];
    signal input path_index[depth];
    signal output root;

    component hashers[depth];
    signal cur[depth + 1];
    signal left[depth];
    signal right[depth];
    cur[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        path_index[i] * (1 - path_index[i]) === 0;

        left[i] <== cur[i] + path_index[i] * (path_elements[i] - cur[i]);
        right[i] <== path_elements[i] + path_index[i] * (cur[i] - path_elements[i]);

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        cur[i + 1] <== hashers[i].out;
    }

    root <== cur[depth];
}
