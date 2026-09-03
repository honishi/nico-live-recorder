import { codedError, ERROR_CODES, parseErrorCode } from '../../src/shared/types';

describe('parseErrorCode', () => {
  test('main が投げたそのままの message から取り出せる', () => {
    expect(parseErrorCode(codedError(ERROR_CODES.userNotFound).message)).toBe(
      ERROR_CODES.userNotFound,
    );
    expect(parseErrorCode(codedError(ERROR_CODES.programUnavailable, 'ended').message)).toBe(
      ERROR_CODES.programUnavailable,
    );
  });

  test('ipcRenderer.invoke が包んだ message からも取り出せる', () => {
    expect(
      parseErrorCode("Error invoking remote method 'recording:start': Error: E_INVALID_PROGRAM"),
    ).toBe(ERROR_CODES.invalidProgram);
    expect(
      parseErrorCode("Error invoking remote method 'targets:add': Error: E_INVALID_INPUT: bad"),
    ).toBe(ERROR_CODES.invalidInput);
  });

  test('コードを含まない message は undefined', () => {
    expect(parseErrorCode('something else')).toBeUndefined();
    expect(parseErrorCode('E_UNKNOWN_CODE')).toBeUndefined();
  });
});
