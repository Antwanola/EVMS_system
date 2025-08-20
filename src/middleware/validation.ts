// src/middleware/validation.ts
import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { Logger } from '@/Utils/logger';

const logger = Logger.getInstance();

export const validateRequest = (schema: Joi.ObjectSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const { error } = schema.validate(req.body);
    if (error) {
      logger.warn(`Validation error: ${error.details[0].message}`);
      return res.status(400).json({
        success: false,
        error: error.details[0].message,
        timestamp: new Date().toISOString(),
      });
    }
    next();
  };
};

// Common validation schemas
export const schemas = {
  remoteStartTransaction: Joi.object({
    idTag: Joi.string().required(),
    connectorId: Joi.number().integer().min(1).optional(),
  }),
  
  remoteStopTransaction: Joi.object({
    transactionId: Joi.number().integer().min(1).required(),
  }),
  
  resetChargePoint: Joi.object({
    type: Joi.string().valid('Hard', 'Soft').default('Soft'),
  }),
  
  unlockConnector: Joi.object({
    connectorId: Joi.number().integer().min(1).required(),
  }),
  
  changeConfiguration: Joi.object({
    key: Joi.string().required(),
    value: Joi.string().required(),
  }),
};