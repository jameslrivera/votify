pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "lib/merkle.circom";

template Vote(depth) {
    signal input root;
    signal input vote_nullifier;
    signal input vote;
    signal input election_id;

    signal input secret;
    signal input nullifier_key;
    signal input path_elements[depth];
    signal input path_index[depth];

    component commit = Poseidon(3);
    commit.inputs[0] <== secret;
    commit.inputs[1] <== nullifier_key;
    commit.inputs[2] <== election_id;

    component tree = MerkleRoot(depth);
    tree.leaf <== commit.out;
    for (var i = 0; i < depth; i++) {
        tree.path_elements[i] <== path_elements[i];
        tree.path_index[i] <== path_index[i];
    }
    root === tree.root;

    component nul = Poseidon(2);
    nul.inputs[0] <== nullifier_key;
    nul.inputs[1] <== election_id;
    vote_nullifier === nul.out;

    signal vote_sq;
    vote_sq <== vote * vote;
}
