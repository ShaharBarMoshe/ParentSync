import { HttpException, HttpStatus, ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockGetRequest: jest.Mock;
  let mockGetResponse: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    mockGetRequest = jest.fn().mockReturnValue({
      method: 'GET',
      url: '/test',
    });
    mockGetResponse = jest.fn().mockReturnValue({
      status: mockStatus,
    });

    mockHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: mockGetRequest,
        getResponse: mockGetResponse,
      }),
      getArgs: jest.fn(),
      getArgByIndex: jest.fn(),
      switchToRpc: jest.fn(),
      switchToWs: jest.fn(),
      getType: jest.fn(),
    } as unknown as ArgumentsHost;
  });

  describe('production mode', () => {
    let filter: AllExceptionsFilter;

    beforeEach(() => {
      filter = new AllExceptionsFilter(true);
    });

    it('should return statusCode and message for HttpException', () => {
      const exception = new HttpException('Not Found', HttpStatus.NOT_FOUND);

      filter.catch(exception, mockHost);

      expect(mockStatus).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(mockJson).toHaveBeenCalledWith({
        statusCode: HttpStatus.NOT_FOUND,
        message: 'Not Found',
      });
    });

    it('should return statusCode and message for HttpException with object response', () => {
      const exception = new HttpException(
        { message: 'Validation failed', errors: ['field required'] },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      expect(mockStatus).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      expect(mockJson).toHaveBeenCalledWith({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Validation failed',
      });
    });

    it('should handle HttpException with array message', () => {
      const exception = new HttpException(
        { message: ['field1 is required', 'field2 is invalid'] },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      expect(mockJson).toHaveBeenCalledWith({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'field1 is required, field2 is invalid',
      });
    });

    it('should return generic message for non-HttpException errors', () => {
      const exception = new Error('Something broke');

      filter.catch(exception, mockHost);

      expect(mockStatus).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(mockJson).toHaveBeenCalledWith({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      });
    });

    it('should not leak stack traces or paths in production', () => {
      const exception = new Error('DB connection failed');

      filter.catch(exception, mockHost);

      const responseBody = mockJson.mock.calls[0][0];
      expect(responseBody).not.toHaveProperty('path');
      expect(responseBody).not.toHaveProperty('timestamp');
      expect(responseBody).not.toHaveProperty('stack');
    });

    it('should handle HttpException with object response without message field', () => {
      const exception = new HttpException(
        { error: 'Something went wrong' },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      expect(mockJson).toHaveBeenCalledWith({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'An error occurred',
      });
    });
  });

  describe('development mode (default)', () => {
    let filter: AllExceptionsFilter;

    beforeEach(() => {
      filter = new AllExceptionsFilter();
    });

    it('should include timestamp and path for HttpException', () => {
      const exception = new HttpException('Not Found', HttpStatus.NOT_FOUND);

      filter.catch(exception, mockHost);

      expect(mockStatus).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      const responseBody = mockJson.mock.calls[0][0];
      expect(responseBody.statusCode).toBe(HttpStatus.NOT_FOUND);
      expect(responseBody.timestamp).toBeDefined();
      expect(responseBody.path).toBe('/test');
      expect(responseBody.message).toBe('Not Found');
    });

    it('should spread object response from HttpException', () => {
      const exception = new HttpException(
        { message: 'Bad Request', errors: ['field1 invalid'] },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, mockHost);

      const responseBody = mockJson.mock.calls[0][0];
      expect(responseBody.statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(responseBody.message).toBe('Bad Request');
      expect(responseBody.errors).toEqual(['field1 invalid']);
      expect(responseBody.timestamp).toBeDefined();
      expect(responseBody.path).toBe('/test');
    });

    it('should return generic message for non-HttpException errors', () => {
      const exception = new Error('Something broke');

      filter.catch(exception, mockHost);

      const responseBody = mockJson.mock.calls[0][0];
      expect(responseBody.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(responseBody.message).toBe('Internal server error');
      expect(responseBody.timestamp).toBeDefined();
      expect(responseBody.path).toBe('/test');
    });

    it('should handle non-Error exceptions (e.g. strings)', () => {
      const exception = 'unexpected string error';

      filter.catch(exception, mockHost);

      const responseBody = mockJson.mock.calls[0][0];
      expect(responseBody.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(responseBody.message).toBe('Internal server error');
    });
  });

  describe('explicit isProduction=false', () => {
    it('should behave the same as default (dev mode)', () => {
      const filter = new AllExceptionsFilter(false);
      const exception = new HttpException('Forbidden', HttpStatus.FORBIDDEN);

      filter.catch(exception, mockHost);

      const responseBody = mockJson.mock.calls[0][0];
      expect(responseBody.statusCode).toBe(HttpStatus.FORBIDDEN);
      expect(responseBody.timestamp).toBeDefined();
      expect(responseBody.path).toBe('/test');
    });
  });
});
