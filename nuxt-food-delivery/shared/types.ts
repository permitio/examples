/** The cities the app serves. Each city is a Permit tenant, so roles are granted per city. */
export const CITIES = ['california', 'washington'] as const;
export type City = (typeof CITIES)[number];

/** The tenant roles a user can hold in a city. */
export const ROLES = ['customer', 'rider', 'vendor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const isCity = (value: unknown): value is City => CITIES.some((city) => city === value);
export const isRole = (value: unknown): value is Role => ROLES.some((role) => role === value);

/** The flat delivery fee, waived when Permit allows `create-with-free-delivery` on the order. */
export const DELIVERY_FEE = 50;

/**
 * The order cost from which customers get free delivery and riders need experience. Permit holds
 * the rule (the `orders_above_500` resource set); the cart uses this only to preview the fee.
 */
export const FREE_DELIVERY_FROM = 500;

/** The number of rides that makes a rider experienced (the `experienced_riders` user set). */
export const EXPERIENCED_RIDER_RIDES = 500;

export interface Meal {
  id: string;
  name: string;
  price: number;
  vendor: string;
  city: City;
}

export interface MealInOrder {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export interface Order {
  id: number;
  city: City;
  meals: MealInOrder[];
  customer: string;
  vendor: string;
  totalPrice: number;
  deliveryFee: number;
  grandTotal: number;
  orderTime: string;
  fulfilledTime?: string;
  admin?: string;
  rider?: string;
  riderAssignedTime?: string;
  deliveredTime?: string;
}

/** Body of `POST /meals`. */
export interface NewMeal {
  name: string;
  price: number;
}

/** Body of `POST /orders`. Prices and the vendor come from the menu, not from the client. */
export interface NewOrder {
  meals: Array<{ id: string; quantity: number }>;
}

/** Body of `POST /users`: grants or revokes a role in a city. */
export interface RoleChange {
  user: string;
  role: Role;
  tenant: City;
  isGrant: boolean;
  noOfRides?: number;
}

/** What the mutating routes answer with. */
export interface ApiMessage {
  message: string;
}
