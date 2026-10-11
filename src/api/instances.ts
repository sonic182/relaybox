import { isValidName, type InstanceService } from '../instances';
import { badRequest, notFound } from './error-core';

export function requireApiInstance(service: InstanceService, instanceName: string) {
  if (!isValidName(instanceName)) throw badRequest('Invalid instance name');

  const instance = service.getInstance(instanceName);
  if (!instance) throw notFound(`The "${instanceName}" instance does not exist`);
  return instance;
}
