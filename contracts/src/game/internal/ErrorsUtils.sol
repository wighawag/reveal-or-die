// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

import "../interfaces/UsingGameEvents.sol";

struct ErrorData {
    bytes4 selector;
    bytes data;
}

struct ErrorsCollector {
    ErrorData[] errors;
    uint256 numErrors;
}

function createErrorsCollector(
    uint256 maxErrorCount
) returns (ErrorsCollector memory collector) {
    return
        ErrorsCollector({errors: new ErrorData[](maxErrorCount), numErrors: 0});
}

function createErrorsCollector() returns (ErrorsCollector memory collector) {
    return createErrorsCollector(10);
}

/// @dev Upon calling this function the contract call need to be terminated
///  and ideally no state should have been changed
//   (This is used to have error without requiring tracing)
/// @param selector Event select
/// @param data abi encoded data
function revertWithEvent(bytes4 selector, bytes memory data) {
    emit UsingGameEvents.Error(selector, data);
}

function revertWithEvent(bytes4 selector) {
    revertWithEvent(selector, bytes(""));
}

library ErrorsUtils {
    function hasErrors(
        ErrorsCollector memory collector
    ) internal returns (bool) {
        return collector.numErrors > 0;
    }

    function collectError(
        ErrorsCollector memory collector,
        bytes4 selector,
        bytes memory data
    ) internal {
        collector.errors[collector.numErrors] = ErrorData({
            selector: selector,
            data: data
        });
        collector.numErrors++;
        emit UsingGameEvents.Error(selector, data);
    }

    function collectError(
        ErrorsCollector memory collector,
        bytes4 selector
    ) internal {
        bytes memory data = bytes("");
        collector.errors[collector.numErrors] = ErrorData({
            selector: selector,
            data: data
        });
        collector.numErrors++;
        emit UsingGameEvents.Error(selector, data);
    }
}
