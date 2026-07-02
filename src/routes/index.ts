import { Router, type IRouter } from "express";
import healthRouter from "./health";
import goaRouter from "./goa";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/goa", goaRouter);

export default router;
